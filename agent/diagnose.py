# Everything we still do not know about this printer, asked in one run.
#
#   python3 agent/diagnose.py            sans papier : USB, requetes, reprise
#   python3 agent/diagnose.py --paper    ajoute le ticket de calibration
#   python3 agent/diagnose.py --tear     mesure tete -> barre de dechirement
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
    title("A. Ce que le bus USB dit de la machine")
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
    print("  Ces identifiants sont utiles si un jour il faut epingler la machine")
    print("  dans config.py (USB_VENDOR_ID / USB_PRODUCT_ID), ou ecrire une regle")
    print("  udev plus precise que la classe 07.")
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
    print("  Le protocole 2 sur une interface de classe 7 veut dire bidirectionnel.")
    print("  C'est ce qui permet de lire l'etat ; un protocole 1 serait muet.")


# --- B. the queries, many times ---------------------------------------------


def query_stability(printer, rounds=15):
    title("B. Les requetes d'etat, %d tours" % rounds)
    print("  Rien n'est imprime.\n")

    order = [1, 2, 3, 4]
    seen = {n: [] for n in order}
    for _ in range(rounds):
        for n in order:
            try:
                seen[n].append(printer._dle_eot(n))
            except ep.PrinterError as err:
                seen[n].append(("ERR", str(err)[:40]))
            time.sleep(0.02)

    names = {1: "etat", 2: "hors-ligne", 3: "erreur", 4: "papier"}
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
            print("             ATTENTION: la valeur change d'un tour a l'autre")
            stable = False

    print()
    # The shift test. Query 1 answered 0x16 and the others 0x12 on 31 August,
    # so query 1 is the one that stands out - which is what makes it usable as
    # a marker. If its value ever turns up as another query's answer, the pipe
    # is off by one.
    marker = set(values.get(1, []))
    others = set(values.get(2, [])) | set(values.get(3, [])) | set(values.get(4, []))
    if marker and marker & others:
        print("  DECALAGE PROBABLE : la valeur de DLE EOT 1 apparait ailleurs.")
        print("  C'est exactement le defaut du 31 aout. Ne pas se fier a l'etat.")
        stable = False
    elif marker:
        print("  Pas de decalage : DLE EOT 1 garde une valeur qui n'est qu'a lui.")

    if stable:
        print("  VERDICT : l'etat est stable et aligne. On peut s'y fier.")
    else:
        print("  VERDICT : l'etat n'est pas fiable. Voir les lignes ci-dessus.")
    return stable


# --- C. how slow is the first question --------------------------------------


def first_answer_latency(printer, rounds=4):
    title("C. Combien de temps l'imprimante met a repondre apres ESC @")
    print("  C'est ce qui avait fausse les deux premieres campagnes : la reponse")
    print("  arrivait apres la fin de l'attente, puis etait lue comme la reponse")
    print("  a la question SUIVANTE. Rien n'est imprime.\n")

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
    title("D. Est-ce qu'elle revient toute seule ?")
    print("  C'est la question qui decide si changer un rouleau demande")
    print("  d'eteindre et rallumer la machine, ou pas. Rien n'est imprime.\n")
    input("  Ouvre le capot, puis appuie sur Entree. ")

    printer.close()
    try:
        printer.open(attempts=1)
        state = printer.status()
        print("  capot ouvert -> elle repond quand meme : %r" % state)
    except ep.PrinterError as err:
        print("  capot ouvert -> injoignable, comme prevu (%s)" % str(err)[:60])

    input("\n  Referme le capot. N'attends pas, appuie sur Entree tout de suite. ")
    started = time.monotonic()
    printer.close()
    while time.monotonic() - started < timeout_s:
        try:
            printer.open(attempts=1, pause_s=0)
            state = printer.status()
            took = time.monotonic() - started
            print("\n  REVENUE toute seule apres %.1f s." % took)
            print("  etat : %r" % state)
            print()
            print("  Donc changer un rouleau ne demande rien de special : l'agent")
            print("  la retrouve seul. Il verifie toutes les %d s." % 30)
            return took
        except ep.PrinterError:
            time.sleep(1.0)
    print("\n  PAS REVENUE en %d s." % timeout_s)
    print("  Il faudra eteindre et rallumer l'imprimante apres chaque rouleau,")
    print("  et c'est a ecrire dans la doc plutot qu'a decouvrir un soir charge.")
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
    title("E. Le ticket de calibration")
    rows = calibration_rows()
    expected_mm = RULER_GAP / ep.DOTS_PER_MM
    print("  %d lignes, environ %.0f mm de papier.\n" % (len(rows), len(rows) / ep.DOTS_PER_MM))
    printer.print_lines(iter(rows), len(rows), feed_lines=120)
    print("  Imprime. Trois choses a regarder, dans l'ordre :\n")
    print("  1. LA DIAGONALE, en haut. C'est la plus importante.")
    print("     Une ligne CONTINUE et reguliere  -> l'ordre des bits est bon.")
    print("     Une echelle de petits batons penches dans l'autre sens")
    print("       -> il est inverse, et tout ce qui s'imprime est faux.")
    print("     Rien d'autre ne prouve ca : le CRC qui correspondait a la")
    print("     premiere impression se calcule AVANT l'inversion, donc il")
    print("     correspondrait aussi bien si l'inversion etait supprimee.\n")
    print("  2. LES DEUX BLOCS et la barre pleine, au milieu.")
    print("     Mesure la barre : elle doit faire environ 72 mm.")
    print("     Les blocs doivent toucher les deux bords de la zone imprimable.\n")
    print("  3. LES DEUX BARRES A MI-LARGEUR, tout en bas.")
    print("     Ce sont les seules qui ne traversent pas toute la largeur :")
    print("     elles s'arretent au quart de chaque bord. Impossible de les")
    print("     confondre avec la barre pleine du point 2.")
    print("     Mesure le BLANC entre elles : attendu %.1f mm." % expected_mm)
    print("     C'est la resolution verticale, dont depend toute longueur")
    print("     calculee dans le projet. Si tu trouves autre chose, dis-le moi :")
    print("     %.1f mm donnerait %.4f points/mm." % (expected_mm, ep.DOTS_PER_MM))


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
    title("G. Est-ce que les lignes blanches font vraiment avancer le papier ?")
    print("  Le ticket de calibration a donne 5 mm la ou 400 lignes blanches")
    print("  devraient en faire 56. Trois causes possibles, et elles ne se")
    print("  reparent pas pareil :")
    print()
    print("    - les BANDES entierement blanches sont ignorees  (128 lignes)")
    print("    - TOUTES les lignes blanches sont ignorees")
    print("    - autre chose")
    print()
    print("  Quatre essais. Chacun est precede de son numero, en petits traits")
    print("  a gauche : un trait, deux traits, trois traits, quatre traits.")
    print("  Mesure le BLANC entre les deux barres pleines de chaque essai.\n")

    plan = [
        (1, 40, False, 40 / ep.DOTS_PER_MM),
        (2, 200, False, 200 / ep.DOTS_PER_MM),
        (3, 400, False, 400 / ep.DOTS_PER_MM),
        (4, 200, True, 200 / ep.DOTS_PER_MM),
    ]
    for index, gap, use_feed, expected in plan:
        how = "ESC J" if use_feed else "lignes blanches"
        print("  essai %d : %3d lignes en %-16s -> attendu %.1f mm" % (index, gap, how, expected))
        _gap_test(printer, index, gap, use_feed)

    print()
    print("  Comment lire le resultat :")
    print()
    print("    1=5.6  2=28  3=56  4=28   tout va bien, le probleme est ailleurs")
    print("    1=5.6  2=28  3=20  4=28   seules les BANDES blanches sautent")
    print("    1=0    2=0   3=0   4=28   TOUTES les lignes blanches sautent")
    print()
    print("  L'essai 4 est le temoin : il avance le papier avec ESC J, la")
    print("  commande d'avance, et pas avec de l'image. S'il tombe juste alors")
    print("  que les autres non, c'est l'image qui est en cause et le correctif")
    print("  est simple : envoyer les blancs en ESC J plutot qu'en trame.")


# --- H. which buzzer command does this printer know? ------------------------


def beep_tests(printer):
    title("H. Le buzzer")
    print("  La commande de buzzer n'est PAS dans la liste du manuel (section 8).")
    print("  La machine en a un - elle bipe sur erreur - mais rien ne documente")
    print("  comment le declencher. Trois candidates, essayees une par une.")
    print()
    print("  L'imprimante est une Sewoo en dessous (0525:A700), donc ESC B est")
    print("  la plus probable : c'est le buzzer des Sewoo et des Citizen.")
    print("  Rien n'est imprime.\n")

    for i, (name, build) in enumerate(ep.BEEP_CANDIDATES):
        input("  Essai %d/%d : %s\n    Entree pour l'envoyer. " % (i + 1, len(ep.BEEP_CANDIDATES), name))
        try:
            printer.beep(times=3, length=2, variant=i)
        except ep.PrinterError as err:
            print("    erreur : %s" % err)
            continue
        time.sleep(1.5)
        print("    envoye. Ca a fait du bruit ?\n")

    print("  Dis-moi le numero de celle qui a marche, et je la fixe dans")
    print("  agent/config.py (BEEP_VARIANT). Si aucune n'a rien fait, on le")
    print("  note dans docs/ESCPOS.md : cette machine ne se laisse pas sonner,")
    print("  et le ticket a tip jar devra se signaler autrement.")


def tear_print(printer):
    title("F. Mesurer la distance tete -> barre de dechirement")
    print("  Imprime un trait et n'avance PAS ensuite, donc le trait reste")
    print("  exactement sous la tete d'impression.\n")
    rows = _bar(3)
    printer.print_lines(iter(rows), len(rows), feed_lines=0)
    print("  Fait. Maintenant :\n")
    print("  1. Dechire le papier sur la barre, normalement.")
    print("  2. Mesure du TRAIT jusqu'au BORD DECHIRE.\n")
    print("  C'est la seule mesure du projet ou partir d'un bord dechire est")
    print("  correct, parce que le bord dechire EST la barre - c'est justement")
    print("  la distance qu'on cherche. Partout ailleurs c'est interdit,")
    print("  et deux estimations contradictoires sont venues de la (ETAT 2.10).\n")
    print("  Donne-moi les millimetres. feed_lines vaut mm x %.4f," % ep.DOTS_PER_MM)
    print("  et il est aujourd'hui a 90, soit %.1f mm - une estimation." % (90 / ep.DOTS_PER_MM))


# --- main -------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Sonde profonde de la TRP 100 III")
    parser.add_argument("--paper", action="store_true", help="ajoute le ticket de calibration")
    parser.add_argument("--tear", action="store_true", help="mesure tete -> barre")
    parser.add_argument("--gaps", action="store_true", help="les lignes blanches avancent-elles ?")
    parser.add_argument("--beep", action="store_true", help="quelle commande fait biper ?")
    parser.add_argument("--recovery", action="store_true", help="test de reprise, interactif")
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
        print("Rien n'a ete imprime. Pour aller plus loin :")
        print("  python3 agent/diagnose.py --recovery   revient-elle seule ? (sans papier)")
        print("  python3 agent/diagnose.py --paper      ordre des bits, largeur, resolution")
        print("  python3 agent/diagnose.py --tear       distance tete -> barre")
    return 0


if __name__ == "__main__":
    sys.exit(main())
