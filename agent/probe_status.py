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
    (1, "etat imprimante", "bit 3 = hors ligne"),
    (2, "cause hors-ligne", "bit 2 = capot ouvert, bit 5 = erreur"),
    (3, "cause erreur", "bit 3 = massicot, bit 5 = irrecuperable"),
    (4, "capteur papier", "bits 2,3 = fin proche, bits 5,6 = rouleau vide"),
]

STATES = [
    "rouleau charge, capot ferme   (l'etat normal, pour comparer)",
    "rouleau RETIRE, capot referme (sors le rouleau et referme)",
    "capot OUVERT",
    "rouleau charge, capot ferme   (remets tout, pour prouver que ca revient)",
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
    print("Rien n'est imprime. Rien n'est modifie.\n")
    verdict = {}

    for n, name in [(4, "papier"), (2, "hors-ligne"), (1, "imprimante"), (3, "erreur")]:
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
        print("VERDICT : la question sur le papier repond a chaque fois.")
        print("Le probleme d'hier etait de la latence sur la premiere requete,")
        print("et le vidage du tuyau l'a corrige. On peut continuer.")
    elif paper:
        print("VERDICT : la question sur le papier repond, mais pas toujours.")
        print("A traiter comme 'repond', avec une marge : une absence de reponse")
        print("ne doit jamais etre lue comme 'plus de papier'. C'est deja le cas.")
    else:
        print("VERDICT : cette imprimante ne repond JAMAIS sur le papier.")
        print("Elle imprimera quand meme - c'est prevu - mais le rouleau vide")
        print("ne sera pas detecte, et il faudra le surveiller a l'oeil.")
        if verdict.get(2):
            print("En revanche DLE EOT 2 repond : le bit 5 y signale 'arret sur")
            print("fin de papier'. C'est peut-etre la vraie source, a verifier")
            print("en faisant le test complet ci-dessous, rouleau retire.")
    print()
    return 0


def main():
    interactive = "--full" in sys.argv
    printer = ep.TRP100()
    try:
        printer.open()
    except ep.PrinterError as err:
        print("cannot reach the printer: %s" % err)
        print("\nSur un Raspberry Pi, les deux causes habituelles :")
        print("  - usblp tient encore le peripherique. Le pilote le detache,")
        print("    mais seulement s'il en a le droit. Essayer sudo, ou poser la")
        print("    regle udev de agent/README.md.")
        print("  - l'imprimante est eteinte, ou le cable USB est un cable de charge.")
        return 1

    if printer._in is None:
        print("Cette imprimante n'expose aucun point de terminaison bulk IN.")
        print("Elle ne peut rien rapporter, et status() repondra toujours 'inconnu'.")
        print("Ce n'est pas bloquant - l'agent imprime quand meme - mais le")
        print("rouleau vide ne sera jamais detecte, et docs/10-escpos.md doit le dire.")
        return 1

    if not interactive:
        code = quick(printer)
        print("Pour le test complet, avec le rouleau retire et le capot ouvert :")
        print("    python3 agent/probe_status.py --full")
        return code

    print("Quatre etats, dans l'ordre. Rien n'est imprime.")
    for label in STATES:
        input("\nMets la machine dans cet etat : %s\n  puis appuie sur Entree." % label)
        time.sleep(0.2)
        sweep(printer, label)

    print("\nColle ce qui precede dans la conversation. Ca remplit la section 3")
    print("de docs/10-escpos.md et remplace les avertissements 'non confirme'")
    print("dans escpos_printer.status() par les vrais bits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
