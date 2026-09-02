-- Print on my desk, D1 schema.
--
-- Idempotent on purpose: this file is applied to both the local and the remote
-- database, and re-applied whenever it changes. Never put a destructive
-- statement in here.
--
-- That guarantee is load-bearing in one more place than it looks. Applying
-- this to a live database has to be safe to do unattended, because the set-up
-- it belongs to is meant to run start to finish without a human at the
-- keyboard - and that is only defensible while nothing in this file can
-- destroy data. A statement that could would need a confirmation back, and
-- every script that applies it changed with it.
--
-- All timestamps are milliseconds since the epoch, so they line up with
-- Date.now() in the Worker and need no conversion anywhere.

-- --------------------------------------------------------------------------
-- jobs: the print queue
-- --------------------------------------------------------------------------
--
-- status, and the only transitions that exist:
--
--   pending   -> approved | rejected      moderation, M5
--   approved  -> printing                 claimed by the Pico, GET /next
--   printing  -> printed | failed         POST /done, or the lease expiring
--
-- printing is a lease, not a state the job rests in. A job claimed by a Pico
-- that then loses power would otherwise sit there forever; the sweep in
-- claimJob() moves anything stale to failed. Deliberately failed rather than
-- back to approved: on a public service a duplicate ticket is more visible,
-- and more confusing, than one that never came out.

CREATE TABLE IF NOT EXISTS jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    text             TEXT    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'pending',
    created_at       INTEGER NOT NULL,
    printed_at       INTEGER,
    ip_hash          TEXT,
    moderation_score REAL,
    expires_at       INTEGER,
    -- Optional, and only ever a Threads handle: letters, digits, dots and
    -- underscores, stored without its leading @. See tidyHandle in limits.js.
    handle           TEXT,
    -- lease
    claimed_at       INTEGER,
    claimed_by       TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    -- how tall the rendered ticket was, in printer lines. Stored so the paper
    -- left on the roll can be estimated: the printer reports "empty" and
    -- nothing else, and it reports it the moment it is too late.
    lines            INTEGER,
    -- what the Pico reported back
    crc              INTEGER,
    error            TEXT
);

-- The hot query is "oldest approved job", run every few seconds by the Pico.
CREATE INDEX IF NOT EXISTS idx_jobs_queue   ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease   ON jobs (status, claimed_at);
-- M5 rate limiting reads this one.
CREATE INDEX IF NOT EXISTS idx_jobs_ip      ON jobs (ip_hash, created_at);
-- The desk's archive: everything that is not waiting, newest first. Without
-- it, "show me the last forty" reads every job in the table and sorts them,
-- once a minute, for as long as somebody has the tab open.
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC);
-- The paper gauge: lines printed since the roll was changed. (status,
-- claimed_at) narrows this to "every ticket ever printed", which is not
-- narrowing at all.
CREATE INDEX IF NOT EXISTS idx_jobs_printed ON jobs (status, printed_at);

-- --------------------------------------------------------------------------
-- settings: kill switch and opening hours
-- --------------------------------------------------------------------------
--
-- Key/value rather than columns so M5's admin page can flip a flag without a
-- migration. Values are text; the Worker coerces them.

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('kill_switch',    '0',             0),
    ('open_hour',      '10',            0),
    ('close_hour',     '20',            0),
    ('timezone',       'Europe/Paris',  0),
    ('poll_interval_s','5',             0),
    ('intensity',      '93',            0),  -- 0x5D, the captured default
    ('feed_lines',     '80',            0);  -- tear-off feed, calibrated in M4

-- --------------------------------------------------------------------------
-- devices: one row per Pico, the heartbeat lands here
-- --------------------------------------------------------------------------
--
-- This carries the printer's state, not just the Pico's. A sleeping printer is
-- a normal state of the system rather than a fault, and M6's public status
-- page has to be able to tell the difference.

CREATE TABLE IF NOT EXISTS devices (
    id             TEXT PRIMARY KEY,
    last_seen      INTEGER NOT NULL,
    printer_state  TEXT,      -- awake | asleep | error | unknown
    temperature    INTEGER,
    battery        INTEGER,
    uptime_ms      INTEGER,
    firmware       TEXT,
    last_error     TEXT,
    prints_ok      INTEGER NOT NULL DEFAULT 0,
    prints_failed  INTEGER NOT NULL DEFAULT 0
);

-- --------------------------------------------------------------------------
-- moderation: why a job got the status it has (M5)
-- --------------------------------------------------------------------------
--
-- A separate table rather than columns on `jobs`, for one dull but decisive
-- reason: SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so a new
-- column would make this file stop being re-appliable. Everything here is
-- CREATE TABLE IF NOT EXISTS, which is the property that lets schema.sql be
-- run against production without thinking twice.
--
-- verdict mirrors the job status the moderator asked for:
--   approved | pending | rejected
-- source says who decided: blocklist | spam | ai | ai-unavailable | admin |
--   expired | duplicate

CREATE TABLE IF NOT EXISTS moderation (
    job_id      INTEGER PRIMARY KEY,
    verdict     TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    reason      TEXT,               -- terms hit, spam signal, AI category
    ai_label    TEXT,               -- raw verdict from Workers AI, kept as-is
    decided_at  INTEGER NOT NULL,
    reviewed_by TEXT,               -- 'admin' once a human has touched it
    reviewed_at INTEGER
);

-- --------------------------------------------------------------------------
-- events: the operational memory (M7)
-- --------------------------------------------------------------------------
--
-- `devices` holds one row, the current state, which is enough to draw a status
-- page and useless for explaining anything. Every incident of 30 August was
-- diagnosed through a USB cable into a laptop, because the firmware's own log
-- goes to the serial port and nowhere else - so a failure at three in the
-- morning left no trace at all.
--
-- Deliberately not a log of everything: a row per keepalive would be tens of
-- thousands a day and would bury the six lines that matter. Only transitions
-- and failures land here, and `sweepEvents` keeps the table bounded.

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    kind        TEXT    NOT NULL,   -- printer_state | print_failed | print_ok | paper | note
    detail      TEXT,
    temperature INTEGER,
    pace_ms     INTEGER,            -- what the BLE write pacing had to climb to
    stalls      INTEGER,            -- EALREADY retries during the transfer
    sent_lines  INTEGER,            -- lines that actually reached the printer
    job_ids     TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_at ON events (at DESC);

-- --------------------------------------------------------------------------
-- challenges: proof-of-work replay protection (M5)
-- --------------------------------------------------------------------------
--
-- One row per solved Altcha challenge, inserted at the moment it is spent.
-- The primary key IS the replay check: a second submission carrying the same
-- solution hits the constraint and is refused. Without this, one solved
-- challenge would let a script post forever.

CREATE TABLE IF NOT EXISTS challenges (
    challenge  TEXT    PRIMARY KEY,
    used_at    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_challenges_gc ON challenges (expires_at);

-- Duplicate detection reads this one: same text, recently, from anyone.
CREATE INDEX IF NOT EXISTS idx_jobs_text ON jobs (text);

-- The expiry sweep reads this one, and it is partial on purpose.
--
-- expirePending asks for pending jobs whose expires_at has passed. Both TTLs
-- have been 0 since 29 August, so nothing is ever given an expires_at and the
-- sweep matches nothing - but "matches nothing" is not "reads nothing": with
-- no index on the column, SQLite read every pending row to check it was NULL.
-- With five thousand queued messages and the agent long-polling every 25
-- seconds, that always-empty query read about seventeen million rows a day,
-- and it is what exhausted D1's free tier on 1 September.
--
-- Partial, so the index holds only the rows that can ever match: it is empty
-- exactly when the feature is off, and the sweep then costs nothing at all.
CREATE INDEX IF NOT EXISTS idx_jobs_expiring
    ON jobs (expires_at) WHERE expires_at IS NOT NULL;

-- M5 settings. INSERT OR IGNORE, so an existing database keeps the values
-- the owner has already tuned and only gains the new keys.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('moderation',      '1',      0),   -- 0 disables the AI pass entirely
    ('moderation_model','@cf/meta/llama-guard-3-8b', 0),
    ('pow_difficulty',  '150000', 0),   -- Altcha maxnumber, ~100 ms in a phone
    ('rate_per_day',    '3',      0),   -- messages per day, per ip_hash
    ('rate_per_hour',   '3',      0),   -- burst guard, per ip_hash
    ('rate_cooldown_s', '300',    0),   -- 5 minutes between two messages
    ('queue_max',       '0',      0),   -- 0 = no cap on the queue
    ('pending_ttl_h',   '0',      0),   -- 0 = never expires; see hold_ttl_h
    ('dedupe_window_h', '24',     0);   -- same text, same person, ignored

-- Everything waits for a tap (added 29 August, at the owner's request).
--
-- hold_all turns the queue into a moderation queue: only the clearly abusive
-- is dropped automatically, and everything else - grey AND clean - waits to be
-- approved from the phone. Validating each ticket is the point rather than an
-- overhead, so this is on by default.
--
-- Two expiries, because one number cannot serve both cases. A grey message is
-- suspicious and two hours is generous. A clean one is somebody's perfectly
-- nice note, and throwing it away because the owner was at dinner would be the
-- system's rudest behaviour by far.
--
-- Both default to 0, which means never, and that is a deliberate departure
-- from the brief: it asked for an unreviewed message to become rejected after
-- two hours. A queued message is a few hundred bytes of text that costs
-- nothing to keep, and "I did not look for five days" is an ordinary week
-- rather than a failure. The mechanism stays - it is one number in /admin -
-- but nothing is thrown away for want of attention.
--
-- The interim value of 24 h was itself a fix for 12 h, which did not survive a
-- night: a message arriving at 19:59 died at 07:59, before the service
-- reopened at 10:00. That whole line of reasoning ends at 0.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('hold_all',   '1',  0),
    ('hold_ttl_h', '0', 0);

-- --------------------------------------------------------------------------
-- supporters: what a tip jar told us about a paid ticket (M8)
-- --------------------------------------------------------------------------
--
-- A separate table rather than columns on `jobs`, for the same dull reason as
-- `moderation`: SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so a
-- new column would stop this file being re-appliable against production.
--
-- source_id is a tip jar's own id for the payment and is the deduplication
-- key. Webhooks are retried: a receiver that does not dedupe prints the same
-- thank-you three times, and the person who paid for it watches it happen.
CREATE TABLE IF NOT EXISTS supporters (
    source_id TEXT    PRIMARY KEY,
    job_id          INTEGER NOT NULL,
    -- Donation | Subscription | Shop Order | Commission
    kind            TEXT    NOT NULL,
    -- Null when the supporter asked to stay private (is_public = false).
    -- a tip jar offers that choice and ignoring it would be rude on paper.
    from_name       TEXT,
    amount          TEXT,
    currency        TEXT,
    tier_name       TEXT,
    received_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supporters_job ON supporters(job_id);

-- --------------------------------------------------------------------------
-- counters: the two numbers that must not be counted
-- --------------------------------------------------------------------------
--
-- D1 bills rows read, and a COUNT reads every row it touches. Two counts here
-- have no bound: how many tickets have been printed, asked by every open tab
-- on the status page, and how many messages are in the queue, asked on every
-- submission. Neither gets cheaper as the project succeeds - a wave that
-- brings five thousand messages brings the tabs that ask about them - and on
-- 1 September the pair helped exhaust the free tier's five million rows a day.
--
-- So they are kept rather than recounted. src/counters.js writes the deltas,
-- and reseeds both from `jobs` once a day so that a missed call site is a
-- number wrong for a few hours rather than forever.
--
-- Deliberately not in `settings`: those are knobs a person turns from /admin,
-- these are bookkeeping the code owns. Mixing them would put a value nobody
-- should edit by hand next to fifteen that exist to be edited.
CREATE TABLE IF NOT EXISTS counters (
    key       TEXT    PRIMARY KEY,
    value     INTEGER NOT NULL DEFAULT 0,
    -- When this counter was last recounted from the source of truth.
    -- 0 means "written by a delta, never verified".
    seeded_at INTEGER NOT NULL DEFAULT 0
);
