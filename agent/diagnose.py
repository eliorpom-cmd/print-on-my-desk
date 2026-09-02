# Everything we still do not know about this printer, asked in one run.
#
#   python3 agent/diagnose.py            no paper: USB, queries, recovery
#   python3 agent/diagnose.py --paper    adds the calibration ticket
#   python3 agent/diagnose.py --tear     measures head -> tear bar
#
# WHY THIS EXISTS
#
# probe_status.py answers one question - what do the status bytes mean - and it
# answered it badly the first time, because it asked each query once and a
# single reading cannot tell a slow answer from a missing one. That is the
# lesson ETAT 2.12 already paid for on the other printer, in capitals:
# MEASURE THE VARIANCE FIRST, NOT LAST. A single observation derailed that
# investigation twice.
#
# So this asks everything many times, and reports the spread rather than a
# value. Where it can only be answered on paper, it prints ONE ticket that
# answers three questions at once instead of three tickets.
#
# WHAT IS STILL UNKNOWN, AND WHY EACH ONE MATTERS
#
#   1. Is the answer shift really gone?  A shifted reading is a WRONG reading
#      that looks right - the worst kind. Fixed by a warm-up query on 31 Aug;
#      unproven until many rounds come back aligned.
#
#   2. Is the bit order right?  NOTHING has proved this yet. The CRC that
#      matched on the first print is computed over our own packing, BEFORE the
#      reversal, so it would match just as well with the reversal removed. The
#      only proof is on paper, and it has to be a feature narrower than a byte.
#
#   3. Are there really 512 dots?  The self-test's "42 Char/Line" says so, and
#      the manual says so, and neither has been held against a ruler.
#
#   4. What is the vertical resolution really?  0.141 mm a dot is from the
#      manual. Every length in the project is computed from it.
#
#   5. How far is the print head from the tear bar?  feedLines is 90 and that
#      is a guess. Too short and no ticket can be torn off.
#
#   6. Does it come back on its own?  It leaves the USB bus when the roll is
#      out or the lid is up. If it does not return by itself, changing a roll
#      means power-cycling it, and that has to be written down.

import argparse
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import escpos_printer as ep


def title(text):
    print("\n" + "=" * 68)
    print(text)
    print("=" * 68)


def bits(value):
    return format(value, "08b")


# --- A. what the bus says ---------------------------------------------------


def usb_identity(printer):
    title("A. What the USB bus says about the machine")
    device = printer.device
    if device is None:
        print("  pas de device")
        return

    def text(index):
        try:
            import usb.util

            return usb.util.get_string(device, index) or "?"
        except Exception:
            return "?"

    print("  idVendor        0x%04X" % device.idVendor)
    print("  idProduct       0x%04X" % device.idProduct)
    print("  bcdDevice       0x%04X" % device.bcdDevice)
    print("  fabricant       %s" % text(device.iManufacturer))
    print("  produit         %s" % text(device.iProduct))
    print("  serie           %s" % text(device.iSerialNumber))
    print()
    print("  These ids are what you need if you ever have to pin the machine")
    print("  down in config.py (USB_VENDOR_ID / USB_PRODUCT_ID), or write a udev")
    print("  rule narrower than class 07.")
    print()
    for configuration in device:
        for interface in configuration:
            print(
                "  interface %d : classe %d, sous-classe %d, protocole %d"
                % (
                    interface.bInterfaceNumber,
                    interface.bInterfaceClass,
                    interface.bInterfaceSubClass,
                    interface.bInterfaceProtocol,
                )
            )
            for endpoint in interface:
                direction = (
                    "IN " if endpoint.bEndpointAddress & 0x80 else "OUT"
                )
                print(
                    "      endpoint 0x%02X  %s  paquet max %d octets"
                    % (endpoint.bEndpointAddress, direction, endpoint.wMaxPacketSize)
                )
    print()
    print("  Protocol 2 on a class 7 interface means bidirectional.")
    print("  That is what lets the status be read; protocol 1 would be mute.")


# --- B. the queries, many times ---------------------------------------------


def query_stability(printer, rounds=15):
    title("B. The status queries, %d rounds" % rounds)
    print("  Nothing is printed.\n")

    order = [1, 2, 3, 4]
    seen = {n: [] for n in order}
    for _ in range(rounds):
        for n in order:
            try:
                seen[n].append(printer._dle_eot(n))
            except ep.PrinterError as err:
                seen[n].append(("ERR", str(err)[:40]))
            time.sleep(0.02)

    names = {1: "status", 2: "offline", 3: "error", 4: "paper"}
    stable = True
    values = {}
    for n in order:
        answers = seen[n]
        got = [a for a in answers if isinstance(a, int)]
        missing = sum(1 for a in answers if a is None)
        errors = sum(1 for a in answers if isinstance(a, tuple))
        distinct = sorted(set(got))
        values[n] = distinct
        print(
            "  DLE EOT %d  %-11s %2d/%d reponses  %s"
            % (
                n,
                names[n],
                len(got),
                rounds,
                " ".join("0x%02X" % v for v in distinct) or "-",
            )
        )
        if missing:
            print("             %d sans reponse" % missing)
            stable = False
        if errors:
            print("             %d erreurs" % errors)
            stable = False
        if len(distinct) > 1:
            print("             WARNING: the value changes from round to round")
            stable = False

    print()
    # The shift test. Query 1 answered 0x16 and the others 0x12 on 31 August,
    # so query 1 is the one that stands out - which is what makes it usable as
    # a marker. If its value ever turns up as another query's answer, the pipe
    # is off by one.
    marker = set(values.get(1, []))
    others = set(values.get(2, [])) | set(values.get(3, [])) | set(values.get(4, []))
    if marker and marker & others:
        print("  LIKELY SHIFT: the DLE EOT 1 value turns up somewhere else.")
        print("  This is exactly the 31 August fault. Do not trust the status.")
        stable = False
    elif marker:
        print("  No shift: DLE EOT 1 keeps a value that is its alone.")

    if stable:
        print("  VERDICT: the status is stable and aligned. It can be trusted.")
    else:
        print("  VERDICT: the status is not reliable. See the lines above.")
    return stable


# --- C. how slow is the first question --------------------------------------


def first_answer_latency(printer, rounds=4):
    title("C. How long the printer takes to answer after ESC @")
    print("  This is what spoiled the first two campaigns: the answer arrived")
    print("  after the wait had ended, and was then read as the answer to the")
    print("  NEXT question. Nothing is printed.\n")

    delays = []
    for i in range(rounds):
        printer.close()
        started = time.monotonic()
        try:
            printer.open()
        except ep.PrinterError as err:
            print("  tour %d : impossible de rouvrir - %s" % (i + 1, err))
            continue
        opened = time.monotonic()
        answer = printer._dle_eot(1)
        done = time.monotonic()
        delays.append(done - opened)
        print(
            "  tour %d : ouverture %.0f ms, premiere reponse %.0f ms, valeur %s"
            % (
                i + 1,
                (opened - started) * 1000,
                (done - opened) * 1000,
                "0x%02X" % answer if answer is not None else "AUCUNE",
            )
        )
        time.sleep(0.3)

    if delays:
        print()
        print(
            "  reponse la plus lente : %.0f ms  (attente accordee : %d ms)"
            % (max(delays) * 1000, 1500)
        )
        if max(delays) > 1.0:
            print("  ATTENTION: proche de la limite. Il faudra l'augmenter.")
        else:
            print("  Marge confortable.")
    return delays


# --- D. does it come back on its own ----------------------------------------


def recovery(printer, timeout_s=90):
    title("D. Does it come back on its own?")
    print("  This is the question that decides whether changing a roll means")
    print("  power-cycling the machine, or not. Nothing is printed.\n")
    input("  Open the lid, then press Enter. ")

    printer.close()
    try:
        printer.open(attempts=1)
        state = printer.status()
        print("  lid open -> it answers anyway: %r" % state)
    except ep.PrinterError as err:
        print("  lid open -> unreachable, as expected (%s)" % str(err)[:60])

    input("\n  Close the lid. Do not wait - press Enter straight away. ")
    started = time.monotonic()
    printer.close()
    while time.monotonic() - started < timeout_s:
        try:
            printer.open(attempts=1, pause_s=0)
            state = printer.status()
            took = time.monotonic() - started
            print("\n  CAME BACK on its own after %.1f s." % took)
            print("  etat : %r" % state)
            print()
            print("  So changing a roll needs nothing special: the agent finds it")
            print("  again by itself. It checks every %d s." % 30)
            return took
        except ep.PrinterError:
            time.sleep(1.0)
    print("\n  PAS REVENUE en %d s." % timeout_s)
    print("  The printer will have to be power-cycled after every roll, and")
    print("  that belongs in the documentation rather than in a busy evening.")
    return None


# --- E. the calibration ticket ----------------------------------------------

# The diagonal advances ONE dot per row, and that is the whole design.
#
# A steeper diagonal was tried first and proved nothing: rendered both ways,
# the two pictures were indistinguishable. Reversing the bits of a byte can
# only move ink within eight dots - 1.1 mm here - so any test whose features
# are wider than a byte, or whose slope crosses a byte in a couple of rows,
# hides the fault inside its own line width.
#
# At one dot per row the line spends eight rows inside each byte, and the
# reversal makes it run BACKWARDS for those eight rows. A continuous line
# becomes a ladder of short strokes leaning the other way. Verified by
# rendering both, side by side, before printing either.
DIAGONAL_ROWS = 192
RULER_GAP = 400  # blank rows between the two ruler bars


def _blank():
    return bytearray(ep.WIDTH_BYTES)


def _set(row, x):
    if 0 <= x < ep.WIDTH_PIXELS:
        row[x >> 3] |= 1 << (x & 7)


def _bar(thickness=4, margin=0):
    rows = []
    for _ in range(thickness):
        row = _blank()
        for x in range(margin, ep.WIDTH_PIXELS - margin):
            _set(row, x)
        rows.append(row)
    return rows


def calibration_rows():
    """One ticket that answers the bit order, the width and the resolution."""
    rows = []

    # 1. The diagonal. THE bit-order test, and the only thing that proves it.
    #
    # Nothing else has. The CRC that matched on the first print is computed
    # over OUR packing, before the reversal, so it matches equally well with
    # the reversal removed - it proves the bytes arrived, not that they are
    # laid down in the right order.
    for y in range(DIAGONAL_ROWS):
        row = _blank()
        for thickness in range(3):  # 3 dots wide so it survives the paper
            _set(row, y + thickness)
        rows.append(row)

    rows += [_blank()] * 16

    # 2. The edges. Eight dots hard against each side, and a full-width bar.
    #    If the paper shows white beyond either block, the printable width is
    #    not what the profile says.
    for _ in range(8):
        row = _blank()
        for x in range(0, 8):
            _set(row, x)
        for x in range(ep.WIDTH_PIXELS - 8, ep.WIDTH_PIXELS):
            _set(row, x)
        rows.append(row)
    rows += [_blank()] * 8
    rows += _bar(3)

    # 3. The ruler: two bars exactly RULER_GAP rows apart.
    #
    # The 100 blank rows before it are not decoration. The first version put
    # the ruler's opening bar 16 rows - 2.3 mm - below the full-width bar of
    # the width test, so the ticket carried three bar-like things within four
    # millimetres and nothing said which pair to measure. the owner measured the
    # wrong pair, read 5 mm where 56 was expected, and we spent an afternoon
    # hunting a bug in the printer that was a bug in this layout.
    #
    # A diagnostic that can be read two ways will be read the wrong way, and
    # the cost is not a wrong number - it is a day chasing it.
    rows += [_blank()] * 100

    # Half-width, so the ruler's bars cannot be confused with the full-width
    # bar of the width test even at a glance.
    rows += _bar(3, margin=ep.WIDTH_PIXELS // 4)
    rows += [_blank()] * RULER_GAP
    rows += _bar(3, margin=ep.WIDTH_PIXELS // 4)

    return rows


def calibration_print(printer):
    title("E. The calibration ticket")
    rows = calibration_rows()
    expected_mm = RULER_GAP / ep.DOTS_PER_MM
    print("  %d lines, about %.0f mm of paper.\n" % (len(rows), len(rows) / ep.DOTS_PER_MM))
    printer.print_lines(iter(rows), len(rows), feed_lines=120)
    print("  Printed. Three things to look at, in order:\n")
    print("  1. THE DIAGONAL, at the top. This is the important one.")
    print("     A CONTINUOUS, even line          -> the bit order is right.")
    print("     A ladder of little strokes leaning the other way")
    print("       -> it is reversed, and everything printed is wrong.")
    print("     Nothing else proves this: the CRC that matched on the first")
    print("     print is computed BEFORE the reversal, so it would match")
    print("     just as well with the reversal removed.\n")
    print("  2. THE TWO BLOCKS and the solid bar, in the middle.")
    print("     Measure the bar: it should be about 72 mm.")
    print("     The blocks should touch both edges of the printable area.\n")
    print("  3. THE TWO HALF-WIDTH BARS, right at the bottom.")
    print("     They are the only ones that do not cross the full width:")
    print("     they stop a quarter in from each edge. Impossible to confuse")
    print("     with the solid bar in point 2.")
    print("     Measure the WHITE between them: expected %.1f mm." % expected_mm)
    print("     That is the vertical resolution, which every length in this")
    print("     project is computed from. If you measure something else:")
    print("     %.1f mm would mean %.4f dots/mm." % (expected_mm, ep.DOTS_PER_MM))


# --- G. do blank raster rows actually feed paper? ---------------------------


def _marks(n):
    """A counter, so the tests can be told apart on the paper without text."""
    rows = []
    for _ in range(n):
        for _ in range(4):
            row = _blank()
            for x in range(0, 24):
                _set(row, x)
            rows.append(row)
        rows += [_blank()] * 6
    return rows


def _gap_test(printer, index, gap_rows, use_feed):
    """One mark, a gap, another mark. The gap is blank raster, or ESC J."""
    rows = _marks(index) + [_blank()] * 4 + _bar(3)
    if not use_feed:
        rows += [_blank()] * gap_rows
    rows += _bar(3)
    if use_feed:
        # Split into two prints with a real feed between them, which is what
        # this case is testing: paper moved by ESC J rather than by blank image.
        head = rows[: -3]
        printer.print_lines(iter(head), len(head), feed_lines=0)
        printer.feed(gap_rows)
        tail = _bar(3)
        printer.print_lines(iter(tail), len(tail), feed_lines=0)
    else:
        printer.print_lines(iter(rows), len(rows), feed_lines=0)
    printer.feed(70)  # a clear separation before the next test


def gap_tests(printer):
    title("G. Do blank lines really advance the paper?")
    print("  The calibration ticket gave 5 mm where 400 blank lines should")
    print("  have given 56. Three possible causes, and they are not fixed")
    print("  the same way:")
    print()
    print("    - entirely blank BANDS are dropped               (128 lines)")
    print("    - ALL blank lines are dropped")
    print("    - something else")
    print()
    print("  Four trials. Each is preceded by its number, as short strokes")
    print("  on the left: one stroke, two, three, four.")
    print("  Measure the WHITE between each trial's two solid bars.\n")

    plan = [
        (1, 40, False, 40 / ep.DOTS_PER_MM),
        (2, 200, False, 200 / ep.DOTS_PER_MM),
        (3, 400, False, 400 / ep.DOTS_PER_MM),
        (4, 200, True, 200 / ep.DOTS_PER_MM),
    ]
    for index, gap, use_feed, expected in plan:
        how = "ESC J" if use_feed else "blank lines"
        print("  trial %d : %3d lines as %-16s -> expected %.1f mm" % (index, gap, how, expected))
        _gap_test(printer, index, gap, use_feed)

    print()
    print("  How to read the result:")
    print()
    print("    1=5.6  2=28  3=56  4=28   all well, the problem is elsewhere")
    print("    1=5.6  2=28  3=20  4=28   only blank BANDS are dropped")
    print("    1=0    2=0   3=0   4=28   ALL blank lines are dropped")
    print()
    print("  Trial 4 is the control: it advances the paper with ESC J, the")
    print("  feed command, rather than with image. If it is right when the")
    print("  others are not, the image is the cause and the fix is simple:")
    print("  send the blanks as ESC J rather than as raster.")


# --- H. which buzzer command does this printer know? ------------------------


def beep_tests(printer):
    title("H. The buzzer")
    print("  The buzzer command is NOT in the manual's list (section 8).")
    print("  The machine has one - it beeps on error - but nothing documents")
    print("  how to trigger it. Candidates, tried one at a time.")
    print()
    print("  The printer is a Sewoo underneath (0525:A700), so ESC B is the")
    print("  most likely: it is the Sewoo and Citizen buzzer.")
    print("  Nothing is printed.\n")

    for i, (name, build) in enumerate(ep.BEEP_CANDIDATES):
        input("  Trial %d/%d: %s\n    Enter to send it. " % (i + 1, len(ep.BEEP_CANDIDATES), name))
        try:
            printer.beep(times=3, length=2, variant=i)
        except ep.PrinterError as err:
            print("    error: %s" % err)
            continue
        time.sleep(1.5)
        print("    sent. Did it make a sound?\n")

    print("  Note the number of the one that worked and pin it in")
    print("  agent/config.py (BEEP_VARIANT). If none of them did anything,")
    print("  write it down in docs/10-escpos.md: this machine cannot be made to")
    print("  beep, and a priority ticket has to announce itself some other way.")


def tear_print(printer):
    title("F. Measuring the head -> tear bar distance")
    print("  Prints a bar and does NOT feed afterwards, so the bar stays")
    print("  exactly under the print head.\n")
    rows = _bar(3)
    printer.print_lines(iter(rows), len(rows), feed_lines=0)
    print("  Done. Now:\n")
    print("  1. Tear the paper off on the bar, normally.")
    print("  2. Measure from the BAR to the TORN EDGE.\n")
    print("  This is the one measurement in the project where starting from a")
    print("  torn edge is correct, because the torn edge IS the bar - that is")
    print("  precisely the distance being looked for. Everywhere else it is")
    print("  forbidden, and two contradictory estimates came from doing it.\n")
    print("  Write down the millimetres. feed_lines is mm x %.4f," % ep.DOTS_PER_MM)
    print("  and it is 90 today, which is %.1f mm - an estimate." % (90 / ep.DOTS_PER_MM))


# --- main -------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Deep probe of the TRP 100 III")
    parser.add_argument("--paper", action="store_true", help="adds the calibration ticket")
    parser.add_argument("--tear", action="store_true", help="measures head -> tear bar")
    parser.add_argument("--gaps", action="store_true", help="do blank lines advance the paper?")
    parser.add_argument("--beep", action="store_true", help="which command makes it beep?")
    parser.add_argument("--recovery", action="store_true", help="recovery test, interactive")
    parser.add_argument("--rounds", type=int, default=15)
    args = parser.parse_args()

    printer = ep.TRP100()
    try:
        printer.open()
    except ep.PrinterError as err:
        print(err)
        return 1

    usb_identity(printer)
    query_stability(printer, args.rounds)
    first_answer_latency(printer)

    if args.recovery:
        recovery(printer)
    if args.beep:
        beep_tests(printer)
    if args.gaps:
        gap_tests(printer)
    if args.paper:
        calibration_print(printer)
    if args.tear:
        tear_print(printer)

    if not (args.paper or args.tear or args.recovery or args.gaps or args.beep):
        print()
        print("Nothing was printed. To go further:")
        print("  python3 agent/diagnose.py --recovery   does it come back? (no paper)")
        print("  python3 agent/diagnose.py --paper      bit order, width, resolution")
        print("  python3 agent/diagnose.py --tear       head -> bar distance")
    return 0


if __name__ == "__main__":
    sys.exit(main())
