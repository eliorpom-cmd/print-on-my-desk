// The two printers, and everything that differs between them.
//
// Until 31 August there was one printer and its geometry was three constants
// scattered through bitmap.js and render.js. The AURES TRP 100 III is wider,
// coarser and reached over USB instead of BLE, and none of those numbers hold:
// 512 dots instead of 384, 0.141 mm per dot instead of 0.125, no keepalive, no
// CRC echo. Rather than edit the constants and lose the small printer, both
// live here and the device says which one it is.
//
// WHY THE SMALL PRINTER STAYS
//
// The MXW01 work is the part of this project worth publishing: a protocol
// reverse-engineered from captures, with three upstream implementations proved
// wrong on four points (docs/PROTOCOL.md). It is paused, not deleted. Every
// path it needs - the 384-wide canvas, the bare layout, firmware/ - still runs
// and is still tested, so the day it is released it is released working.
//
// HOW A PROFILE IS CHOSEN
//
// /api/machine/next?profile=<id>. Absent means mxw01, because the Pico's
// firmware was written before this field existed and must keep working
// untouched - that is the whole point of the paragraph above.

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} label            what a person calls it
 * @property {number} widthPixels      printable dots across
 * @property {number} widthBytes       widthPixels / 8, packed one bit a dot
 * @property {number} dotsPerMm        both axes; every printer here is square
 * @property {number} paperWidthMm     the roll, not the printable area
 * @property {"bare"|"framed"} layout  which ticket design render.js draws
 * @property {number} maxLines         line ceiling, a memory bound of the host
 * @property {number} feedLines        blank lines left after a print
 */

/** 8 dots/mm, 384 dots, 58 mm roll. The pocket BLE printer of M0 to M6. */
const MXW01 = {
  id: "mxw01",
  label: "MXW01 (58 mm, BLE)",
  widthPixels: 384,
  widthBytes: 48,
  dotsPerMm: 8,
  paperWidthMm: 58,
  // The layout of 30 August: message and signature, nothing else. Kept exactly
  // as it shipped. On a 48 mm printable width a title every three centimetres
  // was 40% of the paper, which is what removed it - see render.js.
  layout: "bare",
  margin: 6,
  topPad: 2,
  bottomPad: 4,
  // A memory bound, not a style rule: the Pico buffers the whole bitmap in RAM
  // before it cuts WiFi. 1024 lines is 48 KB against 441 KB free.
  maxLines: 1024,
  // Distance from head to tear bar, measured on paper in M4: ~10 mm.
  feedLines: 7,
  // Settled by the M3 acceptance run: ticket #11 came out upside down, so
  // upstream rotating by 180 degrees was right. Rendered pre-rotated, which
  // keeps the firmware free of any notion of orientation.
  flip180: true,
  transport: "ble",
};

/**
 * 180 dpi, 512 dots, 79.5 mm roll. AURES TRP 100 III, USB, ESC/POS.
 *
 * The numbers are from the manufacturer's manual (section 7-1), not from a
 * listing: 180 x 180 DPI, dot pitch 0.141 mm, printing width max 72 mm
 * (512 dots), paper 79.5 +/- 0.5 mm. It is NOT 576 dots, which is what most
 * 80 mm printers do and what one would otherwise assume.
 *
 * CONFIRMED BY THE MACHINE, 31 August. Its self-test prints "42 Char/Line",
 * and ESC/POS font A is 12 dots wide: 42 columns needs 504 dots and rules out
 * 43. A 576-dot printer would have said 48. So the width below is measured,
 * not read. Firmware Ver 5.16AR, emulation ESC/POS.
 *
 * 7.0866 dots/mm rather than 8 has a consequence worth stating: the same
 * bitmap comes out 13% larger. The font atlas is unchanged and the letters
 * grow from 1.50 to 1.69 mm wide, which is why no atlas was rebuilt.
 */
const TRP100 = {
  id: "trp100",
  label: "AURES TRP 100 III (80 mm, USB)",
  widthPixels: 512,
  widthBytes: 64,
  dotsPerMm: 180 / 25.4, // 7.0866, and written as the division so it is checkable
  paperWidthMm: 79.5,
  // The framed ticket is back, as asked. It was dropped on the small printer
  // because 13 mm of furniture on a 30 mm ticket is most of the ticket; here
  // the same 13 mm of dots is 16 mm on a strip that has room for it.
  layout: "framed",
  // 2.8 mm of white on each side. The old margin was 6 dots, which is 0.75 mm
  // and reads as "the renderer ran out of paper" rather than as a margin.
  margin: 20,
  topPad: 16,
  bottomPad: 24,
  // A Raspberry Pi is not a Pico. This ceiling is no longer about RAM - 8000
  // lines is 512 KB, which the Pi does not notice - it is about how long one
  // uninterruptible print may hold the machine: 8000 lines at 160 mm/s is
  // about seven seconds.
  maxLines: 8000,
  // MEASURED, 31 August: head to tear bar is 29 mm, which is 206 lines.
  //
  // 220 rather than 206, so the tear falls about 2 mm PAST the last printed
  // line rather than through it. Tearing is done by hand and is not precise to
  // the millimetre; a ticket torn exactly on its last line loses its
  // descenders, and there is no way to get them back.
  //
  // It was 90, an estimate carried over from the MXW01's 10 mm, and it was
  // wrong by a factor of two and a half. That printer had no guillotine
  // between its head and its exit; this one does, and the paper path is
  // correspondingly longer. Every ticket would have come out still under the
  // print head, undetachable - the failure this number has when it is short.
  //
  // Paid once per strip, not per ticket, because batching sends several
  // tickets in one print. At eight to a strip that is under 4 mm a ticket.
  //
  // Never a cut. GS V / ESC i / ESC m are simply never sent - docs/ESCPOS.md.
  feedLines: 220,
  // No rotation, and this is the one thing about the switch that is easy to
  // get wrong by inheriting it. GS v 0 prints its first raster line first and
  // the paper feeds out underneath, so the top of the image leaves the slot
  // first and the ticket reads the right way up. The MXW01 needed the flip;
  // asking for it here would print every ticket upside down and backwards.
  flip180: false,
  transport: "escpos",
};

export const PROFILES = { mxw01: MXW01, trp100: TRP100 };

/**
 * What a device that names no profile gets.
 *
 * mxw01 on purpose. The Pico polls `/api/machine/next` with no profile
 * parameter and will keep doing so, because its firmware is frozen for the
 * open-source release; if the default moved, reflashing the board would become
 * a prerequisite for the Worker to be correct, and it is not.
 */
export const DEFAULT_PROFILE = "mxw01";

/** The profile the new machine uses, for tools and previews that must pick one. */
export const CURRENT_PROFILE = "trp100";

/** Resolves a profile id, falling back rather than throwing on junk input. */
export function profileFor(id) {
  return PROFILES[String(id ?? "").toLowerCase()] ?? PROFILES[DEFAULT_PROFILE];
}

/** Printer lines to millimetres of paper, for the gauge and the limits. */
export function linesToMm(lines, profile) {
  return lines / profile.dotsPerMm;
}

/** Millimetres of paper to printer lines, rounded up. */
export function mmToLines(mm, profile) {
  return Math.ceil(mm * profile.dotsPerMm);
}
