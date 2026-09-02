# Settles what this printer's status bytes actually mean.
#
#   python3 agent/probe_status.py
#
# WHY THIS EXISTS
#
# docs/09-protocol.md opens on a rule the whole project has kept: nothing is
# written down without a capture behind it. Following it is what found the four
# things every upstream MXW01 implementation had wrong, including a CRC three
# projects had given up on as "payload unknown".
#
# escpos_printer.status() currently breaks that rule. Its bit meanings come
# from the ESC/POS specification and from the AURES command list, not from this
# machine. That is a guess with a citation, which is still a guess - and the
# byte it guesses about is the one that decides whether an empty roll is
# noticed. The MXW01's version of that mistake cost real messages: it accepted
# a whole ticket with no paper, echoed the correct checksum, and marked the job
# printed with nothing on the floor (ETAT 2.11bis).
#
# So: run this, put the printer through the four states, and write down what
# comes back. docs/10-escpos.md has the table waiting for the numbers.
#
# It never prints. Nothing here sends a raster, a feed or a cut, so it costs no
# paper and can be run as many times as it takes.

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import escpos_printer as ep


# The four real-time queries, and what the specification claims each says.
# Column three is what has to be confirmed rather than believed.
QUERIES = [
    (1, "printer status", "bit 3 = offline"),
    (2, "offline cause", "bit 2 = lid open, bit 5 = error"),
    (3, "error cause", "bit 3 = cutter, bit 5 = unrecoverable"),
    (4, "paper sensor", "bits 2,3 = near end, bits 5,6 = roll empty"),
]

STATES = [
    "roll loaded, lid closed    (the normal state, for comparison)",
    "roll REMOVED, lid closed   (take the roll out and close the lid)",
    "capot OUVERT",
    "roll loaded, lid closed    (put it all back, to prove it recovers)",
]


def bits(value):
    return format(value, "08b")


def sweep(printer, label):
    print("\n--- %s ---" % label)
    for n, name, claim in QUERIES:
        # Per query, because the states this sweep asks for are exactly the
        # ones that can make a printer stop answering. With the lid up it may
        # refuse the write outright, and letting that escape would kill the
        # probe in the middle of the run - losing the readings already taken
        # and requiring the whole physical sequence to be done again.
        try:
            answer = printer._dle_eot(n)
        except ep.PrinterError as err:
            print("  DLE EOT %d  %-18s ERREUR: %s" % (n, name, err))
            # The handle is dropped on a write failure, so put it back for the
            # next query rather than reporting three more phantom errors.
            try:
                printer.open()
            except ep.PrinterError:
                pass
            continue
        if answer is None:
            print("  DLE EOT %d  %-18s pas de reponse" % (n, name))
            continue
        print(
            "  DLE EOT %d  %-18s 0x%02X  %s   (spec: %s)"
            % (n, name, answer, bits(answer), claim)
        )


def quick(printer):
    """Is the printer answering, and is each answer the one we asked for?

    Non-interactive, prints nothing, changes nothing. Run this first.

    It exists because of what the machine did on 31 August: DLE EOT 4 read
    nothing, DLE EOT 2 read 0x12. Two readings of that, and they need different
    fixes:

      shifted   the reply to query 1 arrived too late, sat in the pipe, and was
                read as the answer to query 2. Every later answer is one
                question behind. Invisible in the result, because 0x12 is a
                healthy answer to either question.
      silent    this printer genuinely does not answer DLE EOT 4.

    Asking the same query several times tells them apart. If a query answers
    every time on its own but the first of a run is always missing, it was
    latency. If one query never answers however often it is asked, it is mute.
    """
    print("Nothing is printed. Nothing is changed.\n")
    verdict = {}

    for n, name in [(4, "paper"), (2, "offline"), (1, "printer"), (3, "error")]:
        answers = []
        for _ in range(5):
            answers.append(printer._dle_eot(n))
            time.sleep(0.1)
        got = [a for a in answers if a is not None]
        verdict[n] = got
        shown = " ".join("--" if a is None else "%02X" % a for a in answers)
        print(
            "  DLE EOT %d  %-11s %d/5 reponses   %s"
            % (n, name, len(got), shown)
        )
        if got and len(set(got)) > 1:
            print("             (les reponses varient : %s)" % sorted(set(got)))

    print()
    paper = verdict.get(4, [])
    if len(paper) == 5:
        print("VERDICT: the paper query answers every time.")
        print("Yesterday's problem was latency on the first query, and")
        print("flushing the pipe fixed it. Safe to carry on.")
    elif paper:
        print("VERDICT: the paper query answers, but not always.")
        print("Treat as 'answers', with a margin: a missing answer must never")
        print("be read as 'out of paper'. That is already the case.")
    else:
        print("VERDICT: this printer NEVER answers about paper.")
        print("It will print anyway - that is by design - but an empty roll")
        print("will not be detected, and has to be watched by eye.")
        if verdict.get(2):
            print("DLE EOT 2 does answer, though: its bit 5 reports 'stopped on")
            print("end of paper'. That may be the real source; confirm it with")
            print("the full test below, with the roll removed.")
    print()
    return 0


def main():
    interactive = "--full" in sys.argv
    printer = ep.TRP100()
    try:
        printer.open()
    except ep.PrinterError as err:
        print("cannot reach the printer: %s" % err)
        print("\nOn a Raspberry Pi, the two usual causes:")
        print("  - usblp still holds the device. The driver detaches it, but")
        print("    only if it is allowed to. Try sudo, or install the udev")
        print("    regle udev de agent/README.md.")
        print("  - the printer is off, or the USB cable is a charging cable.")
        return 1

    if printer._in is None:
        print("This printer exposes no bulk IN endpoint.")
        print("It can report nothing, and status() will always answer 'unknown'.")
        print("Not a blocker - the agent prints anyway - but an empty roll")
        print("will never be detected, and docs/10-escpos.md must say so.")
        return 1

    if not interactive:
        code = quick(printer)
        print("For the full test, with the roll removed and the lid open:")
        print("    python3 agent/probe_status.py --full")
        return code

    print("Four states, in order. Nothing is printed.")
    for label in STATES:
        input("\nPut the machine in this state: %s\n  then press Enter." % label)
        time.sleep(0.2)
        sweep(printer, label)

    print("\nPaste everything above into your notes. It fills section 3 of")
    print("docs/10-escpos.md and replaces the 'unconfirmed' warnings in")
    print("escpos_printer.status() with the real bits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
