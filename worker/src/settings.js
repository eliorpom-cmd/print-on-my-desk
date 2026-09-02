// Settings and the kill switch.
//
// Opening hours are gone, and their removal is a deliberate departure from
// constraint 3 of the brief. The window existed so that nothing would come out
// of the printer at four in the morning. Since M5 nothing comes out of the
// printer on its own at all: every message waits in the queue for a tap, so
// the hour a message is WRITTEN no longer decides the hour it is PRINTED.
// Refusing a message at 20:01 stopped protecting anything and only lost the
// message. What still needs to stop the service is the kill switch, which is
// deliberate rather than clock-driven.
//
// The timezone stays: the daily quota and the date on the ticket both need it.

const DEFAULTS = {
  kill_switch: "0",
  timezone: "Europe/Paris",
  poll_interval_s: "5",
  // Which machine is in service. Read by the paper gauge and the desk, and by
  // nothing on the wire: a device is served the profile it ASKS for, in its
  // /api/machine/next query, because it is the only party that knows what it
  // is actually plugged into. See profiles.js.
  printer_profile: "mxw01",
  // "Thank-yous only". The queue goes on filling and being moderated; the
  // printer stays quiet for everything except somebody who paid on a tip jar.
  //
  // For the evenings when four thousand messages are waiting and the machine
  // needs to work as a doorbell rather than as a backlog. Nothing is lost -
  // the rest of the queue is exactly where it was when this is turned off.
  only_supporters: "0",
  // When Season 1 stops taking new messages. Epoch ms, "0" meaning never.
  //
  // Deliberately NOT part of isOpen(), and that separation is the whole point.
  // isOpen() is the kill switch, and handleNext() reads it: a closed season
  // answering there would stop the PRINTER too, and the reason for closing is
  // the opposite - five thousand approved messages have to go on coming out
  // for weeks after the form is gone. Submissions end at an instant. Printing
  // does not end at all.
  closes_at: "0",
  // Print head intensity, 0x00-0xC0. An MXW01 command (A2) with no equivalent
  // in the TRP 100 III's command list - that printer's density lives in a
  // memory switch, set once from its own utility, not per print. The ESC/POS
  // agent reads this field and ignores it, which is stated here so that a
  // value changed on the desk is not expected to do anything.
  intensity: "93",
  // Blank lines fed after a print, to put the last line past the tear bar.
  //
  // One key per printer, because the distance from print head to tear bar is a
  // property of the machine and the two differ by more than a centimetre. A
  // single row holding the MXW01's 7 would have fed the TRP 100 III one
  // millimetre and made every ticket undetachable - see jobs.js.
  //
  // Empty means "whatever the profile says": 7 on the MXW01 (measured on paper
  // in M4) and 90 on the TRP 100 III (an estimate, still to be measured the
  // same way - print two marks, measure the white between them, and never
  // measure from a torn edge).
  feed_lines_mxw01: "",
  feed_lines_trp100: "",
  // How many printer lines one batched strip may carry. Deliberately well
  // under MAX_LINES: the Pico's BLE writes stall on long transfers
  // (OSError 114 EALREADY), and on 30 August strips of ~900 lines lost
  // eighteen tickets in an afternoon. A shorter strip both stalls less and
  // costs less when it does fail. Raise it from /admin once a run of prints
  // comes back with last_pace_ms still at 8.
  // Raised from 500 on the evidence of 30 August rather than on nerve: strips
  // of 913 to 1006 lines printed cleanly that afternoon, the failures at that
  // size were the write race the adaptive pacing now absorbs, and a strip that
  // does fail mid-transfer now only loses the tickets it actually reached.
  // MAX_LINES (1024) remains the hard bound - that one is the Pico's RAM.
  max_batch_lines: "900",
  // The paper gauge. roll_changed_at is stamped when the owner says the roll is
  // new; roll_length_m is what a roll holds, 0 meaning "do not guess".
  roll_changed_at: "0",
  // 0, and deliberately so, since the printer changed on 31 August.
  //
  // The 58 mm roll held 4 m. That number is in this file because the owner
  // measured it on 30 August, after the gauge had spent a fortnight assuming
  // 10 and being wrong by a factor of two and a half. An 80 mm roll is sold by
  // the tens of metres and the listings disagree with each other, so the gauge
  // says nothing at all until somebody has run one roll out and written down
  // what it did. Saying nothing is the only reading that cannot be wrong.
  roll_length_m: "0",
  // Print-head thermostat, served to the Pico in every heartbeat so it can be
  // tuned without reflashing the board.
  //
  // head_max_c: refuse to start a print above this. The head keeps climbing
  // for a second or two after a print ends - a reading of 39 once became 46 -
  // so this needs headroom under whatever the hardware tolerates. The machine
  // itself was seen at 52 C without objecting (M4, 28 August), which is the
  // only evidence anyone has about its real limit.
  //
  // cool_to_c: how far it must fall before work resumes. Raising BOTH is what
  // buys throughput: cooling is proportional to the gap with room air, so a
  // head working hotter sheds heat faster. Raising only the ceiling widens the
  // band and lengthens both halves of the cycle for almost nothing.
  head_max_c: "38",
  cool_to_c: "34",
};

/**
 * Reads the whole settings table into a plain object.
 *
 * NOT CACHED, and that is a decision rather than an omission.
 *
 * It is about forty rows on every request that can be refused - the submit
 * path, the machine poll, the heartbeat - which on the worst day this project
 * has had came to a few hundred thousand rows, against a daily allowance of
 * five million. Eight per cent of the budget, for the table that holds the
 * kill switch.
 *
 * A ten-second cache was written here on 1 September and taken out the same
 * hour. It saved that eight per cent and cost something worth much more: the
 * kill switch became a thing that takes effect SOMETIMES, up to ten seconds
 * later, on isolates you cannot see. The moment a person flips it is the one
 * moment they need it to have already happened, and "it will be off shortly"
 * is not what that switch is for. The integration suite said so too - half of
 * it went red, because a test that closes the shop and then knocks on the door
 * is testing exactly the property the cache broke.
 *
 * The reads that actually threatened the free tier were never this one. They
 * were the queue scans, and they are gone (jobs.js, counters.js, schema.sql).
 */
export async function loadSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const settings = { ...DEFAULTS };
  for (const row of results) settings[row.key] = row.value;
  return settings;
}

/**
 * Is the service accepting messages right now?
 *
 * One reason to say no, and it is a person deciding rather than a clock.
 * Returns { open, reason } - reason is what the public page will show.
 */
export function isOpen(settings) {
  if (settings.kill_switch === "1") {
    return { open: false, reason: "paused" };
  }
  return { open: true, reason: "open" };
}

/**
 * Is the form still taking messages?
 *
 * Read by the submit handler and reported by /api/status. The browser is told
 * the answer rather than the deadline: a phone with a wrong clock must not be
 * able to end the season early, nor to keep writing after it is over.
 */
export function acceptingMessages(settings, now = Date.now()) {
  const closesAt = Number(settings.closes_at);
  const over = Number.isFinite(closesAt) && closesAt > 0 && now >= closesAt;
  return { accepting: !over, seasonOver: over, closesAt: closesAt > 0 ? closesAt : 0 };
}

/**
 * The one gate every path that can create a job has to pass.
 *
 * It exists because there were two of them and they were checked separately,
 * in one handler, by hand - so a second way in was a second place to remember,
 * and the a tip jar webhook did not remember. Closing the season stopped the form
 * and left the webhook creating approved jobs, which is precisely the shape of
 * "it says closed but things still reach the printer".
 *
 * Two reasons to refuse, and they are not the same kind of thing:
 *
 *   * `paused` is the kill switch. A person decided the machine stops now.
 *     No key opens it, and that is the point of having it.
 *   * `season_over` is a schedule. Schedules have exceptions, so the private
 *     door (access.js) opens this one and only this one.
 *
 * `reason` is what the page shows, so it stays as it was: the wording of a
 * refusal is not a place to be inventive.
 */
export function submissionGate(settings, { now = Date.now(), privateAccess = false } = {}) {
  const kill = isOpen(settings);
  if (!kill.open) return { open: false, reason: kill.reason, privately: false };

  const season = acceptingMessages(settings, now);
  if (season.accepting) return { open: true, reason: "open", privately: false };
  if (privateAccess) return { open: true, reason: "private", privately: true };
  return { open: false, reason: "season_over", privately: false };
}

/**
 * Midnight of the current day, in the configured timezone, as an epoch ms.
 *
 * The daily quota resets on the owner's calendar, not on UTC's: someone posting at
 * 00:30 Paris time in January would otherwise still be spending yesterday's
 * allowance. Derived by subtracting the local wall clock from `now`, which is
 * exact on every day except the two that DST moves, where it is an hour out
 * and nobody cares.
 */
export function startOfDayIn(timeZone, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return now - sinceMidnight - (now % 1000);
}

/** Coerces a settings value to a number, falling back when it is nonsense. */
export function num(settings, key, fallback) {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? value : fallback;
}
