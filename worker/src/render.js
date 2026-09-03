// Text -> printer lines. The only place a ticket's look is decided.
//
// Constraint 7 of the brief: no text rendering on the machine, ever. The
// Worker produces the packed lines and the machine only relays bytes. That
// survived the move from BLE to USB unchanged, and it is the reason the switch
// was a week of work rather than a rewrite: a Raspberry Pi could rasterise
// text perfectly well, and letting it would put the look of the ticket on a
// box in the flat instead of in this file.
//
// TWO LAYOUTS, AND WHY BOTH SURVIVE
//
// The geometry comes from profiles.js, and so does the choice of layout:
//
//   framed  title, rules, reference and date, with margins that read as
//           margins. What both printers draw since 3 September.
//   bare    message and signature, nothing else. What the MXW01 drew from 30
//           August to 3 September, and still the right answer at volume.
//
// The choice is arithmetic, not taste. The furniture costs about 13 mm a
// ticket whatever the paper: on a 72 mm strip that is a header, and on a 30 mm
// one it is 40% of the ticket. THAT is what removed it here for a month - this
// deployment's queue passed a thousand messages and a four-metre roll holds
// 132 tickets - and it is why `bare` is still here rather than deleted. A
// printer somebody points a public link at wants it; a printer on a desk
// printing what friends send does not, and comes out looking like a mistake
// without a rule at each end.

import { Canvas } from "./bitmap.js";
import { PROFILES, DEFAULT_PROFILE, profileFor } from "./profiles.js";
import {
  fold,
  glyph,
  minimumLeading,
  embolden,
  ADVANCE,
  CELL_WIDTH,
  HEIGHT,
} from "./font.js";

export const LAYOUT = {
  // Baseline-to-baseline, measured from the glyphs rather than assumed.
  //
  // This was HEIGHT - 2, which was exactly the safe minimum for the 22 px
  // atlas and one row too tight the moment the font was rebuilt at 20 px -
  // descenders would have printed into the accents below them, on paper,
  // with nothing in the tests to notice. See minimumLeading in font.js.
  lineHeight: minimumLeading(),
  paragraphGap: 6,
  ruleGap: 6,
  // Air above and below the rule that separates two tickets of one batch.
  batchGap: 8,
  title: "PRINT ON MY DESK",
};

/**
 * Kept for the tests and tools that predate profiles.js.
 * @deprecated read `profile.flip180` instead - it is false on the TRP 100 III.
 */
export const FLIP_180 = PROFILES[DEFAULT_PROFILE].flip180;

/** How many characters fit on a line, inside the margins. */
export function charsPerLine(profile = PROFILES[DEFAULT_PROFILE], margin = profile.margin) {
  return Math.floor((profile.widthPixels - 2 * margin) / ADVANCE);
}

/**
 * Greedy word wrap. Breaks on spaces, and hard-splits any word longer than a
 * line, because a forty-character run of one letter is exactly the sort of
 * thing a public form receives.
 */
export function wrap(text, width) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      let w = word;
      while (w.length > width) {
        if (current) {
          lines.push(current);
          current = "";
        }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!w) continue;
      if (!current) current = w;
      else if (current.length + 1 + w.length <= width) current += " " + w;
      else {
        lines.push(current);
        current = w;
      }
    }
    lines.push(current);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function drawText(canvas, text, x, y, { bold = false } = {}) {
  let cx = x;
  for (const ch of text) {
    const rows = bold ? embolden(glyph(ch)) : glyph(ch);
    canvas.drawGlyph(rows, cx, y, 1, CELL_WIDTH);
    cx += ADVANCE;
  }
  return y + HEIGHT;
}

/** dd/mm HH:MM in Europe/Paris, whatever the Worker's own clock thinks. */
export function shortDate(ms, timeZone = "Europe/Paris") {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "??";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

/**
 * Draws the body text and returns the y just past its descenders.
 *
 * Shared by both layouts, because the message is the one thing they agree on.
 */
function drawBody(canvas, text, profile, y) {
  const body = wrap(fold(text).trim(), charsPerLine(profile));
  const top = y;
  for (const line of body) {
    drawText(canvas, line, profile.margin, y);
    y += LAYOUT.lineHeight;
  }
  // The last line still needs room for its descenders, which lineHeight - a
  // baseline step - does not include.
  return top + Math.max(0, body.length - 1) * LAYOUT.lineHeight + HEIGHT;
}

/**
 * The frugal ticket: the message, and whoever signed it.
 *
 * Written on 30 August, when the queue passed a thousand and a four-metre roll
 * turned out to hold 132 tickets. What it drops: the PRINT ON MY DESK title and
 * rule at the top, and the "#id date" line and rule at the bottom. Together
 * they are 13 mm of every ticket - 40% of the paper, against 32% for what
 * people actually wrote - and on a continuous strip nobody tears apart, a
 * title every three centimetres is repetition rather than identity.
 *
 * NO PROFILE SELECTS IT TODAY, and it is not dead code. It is what to set
 * `layout` to when a link goes further than expected and the paper starts to
 * cost real money - which has happened here once, and is the reason this
 * function exists at all. The cost of choosing it is worth naming: a ticket on
 * the floor no longer says which message it is, and looking one up means
 * searching its text in /admin.
 */
function composeBare(canvas, text, profile, { id, handle }) {
  let y = drawBody(canvas, text, profile, profile.topPad);
  // Reference and signature share one line, because two would cost 3.5 mm on
  // every ticket to say very little. The number is there because a ticket on
  // the floor has to be findable again in /admin; the date and time are not,
  // because nobody looks a message up by the minute it arrived.
  const footer = handle ? `#${id}  @${handle}` : `#${id}`;
  drawText(canvas, footer, profile.margin, y + 2);
  canvas.feed(profile.bottomPad);
}

/**
 * The framed ticket, back on 31 August for the TRP 100 III.
 *
 * This is the M4 design, restored rather than reinvented - same title, same
 * two-row rule, same one-row rule over the reference line, same handle on its
 * own line. What changed is only what the wider paper allows: real margins,
 * and padding at both ends that a person would call a margin.
 *
 * It costs about 16 mm a ticket. That was indefensible on a 30 mm ticket and
 * is ordinary on a 72 mm one, and the printer no longer ejects three
 * centimetres of its own accord, so the arithmetic that removed it is gone
 * along with the printer it applied to.
 */
function composeFramed(canvas, text, profile, { id, createdAt, handle }) {
  const { margin } = profile;
  let y = profile.topPad;

  y = drawText(canvas, LAYOUT.title, margin, y, { bold: true });
  y = canvas.rule(y + 2, 2, margin) + LAYOUT.ruleGap;

  y = drawBody(canvas, text, profile, y);

  y = canvas.rule(y + LAYOUT.paragraphGap, 1, margin) + 4;
  y = drawText(canvas, `#${id}  ${shortDate(createdAt)}`, margin, y);
  // The signature goes on its own line: the reference and the date already
  // fill most of one, and a thirty-character handle would not fit beside them.
  if (handle) drawText(canvas, `@${handle}`, margin, y + LAYOUT.lineHeight - HEIGHT);
  canvas.feed(profile.bottomPad);
}

/**
 * The thank-you ticket for someone who paid on a tip jar.
 *
 * Deliberately the loudest thing this printer makes. Two solid black bands the
 * full width of the paper, the name doubled in size, and the amount. On a roll
 * where every other ticket is grey text on white, a black band is the one thing
 * visible from across the room - which is the entire point of it.
 *
 * The bands cost ink and paper, and that is not an accident either: a ticket
 * that cost somebody money should look like it cost something to make.
 *
 * The supporter's own message goes through the same filtering as any other
 * submission. Paying does not buy a way past moderation - it is still a
 * stranger's words coming out on paper in somebody's flat.
 */
function composeSupporter(canvas, text, profile, { id, createdAt, supporter }) {
  const { margin } = profile;
  const BAND = 14; // ~2 mm of solid black
  let y = profile.topPad;

  // One band, not three. Three was an attempt to make the ticket AUDIBLE,
  // after the printer turned out to have no buzzer a command can reach. It
  // worked and it was ugly, and it was solving the wrong problem: the alert
  // belongs on a phone, not on the paper. A notification goes out the moment a
  // priority ticket is created, which arrives before the ticket does and works
  // from anywhere.
  y = canvas.rule(y, BAND, 0) + LAYOUT.ruleGap;

  // The name at double size. drawGlyph scales by whole numbers only, so this
  // is exactly twice the body text rather than an awkward 1.5.
  const name = supporter.from_name || "ANONYMOUS";
  let cx = margin;
  for (const ch of name.slice(0, 14)) {
    canvas.drawGlyph(embolden(glyph(ch)), cx, y, 2, CELL_WIDTH);
    cx += ADVANCE * 2;
  }
  y += HEIGHT * 2;

  const money = [supporter.amount, supporter.currency].filter(Boolean).join(" ");
  const line = supporter.tier_name ? `${money}  -  ${supporter.tier_name}` : money;
  if (line.trim()) y = drawText(canvas, line, margin, y + 4, { bold: true });

  y = canvas.rule(y + LAYOUT.paragraphGap, 2, margin) + LAYOUT.ruleGap;

  if (text && text.trim()) {
    y = drawBody(canvas, text, profile, y);
    y += LAYOUT.paragraphGap;
  }

  y = drawText(canvas, `#${id}  ${shortDate(createdAt)}`, margin, y);
  y = canvas.rule(y + LAYOUT.ruleGap, BAND, 0);
  canvas.feed(profile.bottomPad);
}

/**
 * Draws one ticket the right way up, without rotating or trimming it.
 *
 * Split out of renderTicket for the sake of batches. A batch is several
 * tickets on one strip, and any rotation has to happen once, over the whole
 * strip, at the very end: rotating each ticket first and then concatenating
 * would print the batch back to front, because rotate180 reverses row order.
 * Composing upright and flipping once keeps the reading order of the strip the
 * same as the order of the array.
 *
 * @returns {Canvas} upright, untrimmed
 */
export function composeTicket(
  text,
  {
    id = 0,
    createdAt = Date.now(),
    handle = null,
    profile = DEFAULT_PROFILE,
    // { from_name, amount, currency, tier_name } when a tip jar paid for this one.
    // Overrides the profile's layout: a thank-you looks the same on either
    // printer, because what makes it different is that somebody paid.
    supporter = null,
  } = {}
) {
  const p = typeof profile === "string" ? profileFor(profile) : profile;
  const canvas = new Canvas(p.widthPixels);
  const options = { id, createdAt, handle, supporter };
  if (supporter) composeSupporter(canvas, text, p, options);
  else if (p.layout === "framed") composeFramed(canvas, text, p, options);
  else composeBare(canvas, text, p, options);
  return canvas;
}

/**
 * Renders one ticket, ready for transmission.
 * @returns {Canvas}
 */
export function renderTicket(text, options = {}) {
  const p =
    typeof options.profile === "string" || options.profile === undefined
      ? profileFor(options.profile ?? DEFAULT_PROFILE)
      : options.profile;
  const canvas = composeTicket(text, { ...options, profile: p });
  if (p.flip180) canvas.rotate180();
  // No trimTail any more, and that is not an oversight.
  //
  // It removed blank rows from the end of the transmission, which after the
  // rotation is the TOP of the ticket. While there was a title up there it ate
  // two rows of padding and nothing else. With the title gone it eats into the
  // first line of the message: a line of lowercase has six blank rows above
  // its x-height and a line of accented capitals has none, so the same message
  // came out a different height depending on its first character, and the text
  // started flush against the tear line.
  //
  // The padding is stated in the layout, so trimming it served no purpose
  // beyond saving a quarter of a millimetre.
  return canvas;
}

/**
 * Renders several tickets onto one continuous strip, for a single print.
 *
 * On the MXW01 this existed for paper: the printer ejected roughly three
 * centimetres of its own accord at the end of every print (docs/09-protocol.md 6.2),
 * so sixteen tickets sent one at a time cost sixteen of those margins.
 *
 * The TRP 100 III does not do that, and the saving there is a different one:
 * one feed to the tear bar instead of sixteen, and one USB transfer instead of
 * sixteen round trips. Smaller, but the mechanism was already built and
 * correct, so it stays.
 *
 * The caller is responsible for the line budget: profile.maxLines is a bound
 * on the host, not on this function.
 *
 * @param {{text: string, id: number, created_at: number, handle: string|null}[]} jobs
 * @returns {Canvas}
 */
export function renderBatch(jobs, { profile = DEFAULT_PROFILE } = {}) {
  const p = typeof profile === "string" ? profileFor(profile) : profile;
  const strip = new Canvas(p.widthPixels);
  jobs.forEach((job, index) => {
    if (index > 0) {
      // A dashed line with air on both sides. On the bare layout it is the
      // only thing marking where one message ends and the next begins; on the
      // framed one the titles do that too, and it reads as the tear line it is.
      strip.feed(LAYOUT.batchGap);
      strip.dashedRule(strip.height, 6, 5, p.margin);
      strip.feed(LAYOUT.batchGap);
    }
    strip.append(
      composeTicket(job.text, {
        id: job.id,
        createdAt: job.created_at,
        handle: job.handle ?? null,
        profile: p,
      })
    );
  });
  if (p.flip180) strip.rotate180();
  // Deliberately not trimmed - see renderTicket.
  return strip;
}

/**
 * The pattern that proves a transfer rather than a render.
 *
 * A blank or uniform image is worthless as a transport test: CRC8 over a
 * buffer of zeros is zero, and stays zero when half the lines go missing. Each
 * line here carries its own index, so the CRC catches both dropped lines and
 * lines arriving out of order - the two things write-without-response does not
 * guarantee. It stays useful on USB for the same reason a checksum does.
 */
export function renderProbe(lines = 32, profile = DEFAULT_PROFILE) {
  const p = typeof profile === "string" ? profileFor(profile) : profile;
  const canvas = new Canvas(p.widthPixels);
  for (let y = 0; y < lines; y++) {
    canvas.ensure(y)[0] = (y + 1) & 0xff;
  }
  return canvas;
}
