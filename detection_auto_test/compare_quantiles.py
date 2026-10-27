"""
Comparaison de QUANTILE_PIED : 2 % (vert) vs 5 % (cyan).

Même pipeline que verifie_pieds.py, mais les DEUX positions de pieds sont
calculées et dessinées sur la même vidéo annotée, avec des statistiques
chiffrées pendant une phase de vol et une phase de contact connues.

→ verification_quantiles.mp4 : vert = quantile 2 %, cyan = quantile 5 %.
"""

import io
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
import imageio_ffmpeg

VIDEO_DEFAUT = "WhatsApp Video 2026-10-27 at 14.29.28.mp4"
SEUIL_DIFF = 25
QUANTILES = [0.02, 0.1]     # positions calculées et dessinées
COULEURS = [(60, 255, 60), (60, 220, 255)]  # vert, cyan
NB_ECHANTILLONS_FOND = 64
TAILLE_MIN_MASQUE = 50

# Fenêtres de vérification (frames 0-based) — phase de vol puis de contact
FENETRES = {
    "vol (~frames 575-605)": (575, 605),
    "contact (~frames 545-560)": (545, 560),
    "vol (~frames 1090-1120)": (1090, 1120),
    "contact (~frames 1055-1075)": (1055, 1075),
}


def ffmpeg_exe() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_video(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def demarrer_decodage_couleur(exe: str, chemin: Path):
    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    image.close()
    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-fps_mode", "passthrough",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    return proc, l, h


def lire_frame(proc, taille: int) -> np.ndarray | None:
    assert proc.stdout is not None
    buf = proc.stdout.read(taille)
    if not buf or len(buf) < taille:
        return None
    return np.frombuffer(buf, np.uint8)


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO_DEFAUT)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = ffmpeg_exe()
    fps = probe_video(exe, chemin)

    # Passe 1 : comptage + fond
    proc, l, h = demarrer_decodage_couleur(exe, chemin)
    taille = l * h * 3
    total = 0
    while lire_frame(proc, taille) is not None:
        total += 1
    proc.wait()
    pas = max(1, total // NB_ECHANTILLONS_FOND)

    proc, _, _ = demarrer_decodage_couleur(exe, chemin)
    echantillons = []
    n = 0
    while True:
        frame = lire_frame(proc, taille)
        if frame is None:
            break
        if n % pas == 0:
            echantillons.append(frame.reshape(h, l, 3).mean(axis=2))
        n += 1
    proc.wait()
    fond = np.median(np.stack(echantillons), axis=0).astype(np.int16)
    print(f"{total} frames {l}x{h} | fond médian sur {len(echantillons)} échantillons")

    # Passe 2 : masque + deux positions + encodage + stats
    # Nom de sortie unique (n'écrase pas une vidéo encore ouverte dans un lecteur)
    etiquettes = "_".join(f"q{int(q * 100)}" for q in QUANTILES)
    sortie = chemin.parent / f"verification_quantiles_{etiquettes}.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", str(fps),
         "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    positions: list[list[float]] = [[] for _ in QUANTILES]
    fiables: list[list[bool]] = [[] for _ in QUANTILES]

    proc, _, _ = demarrer_decodage_couleur(exe, chemin)
    n = 0
    while True:
        frame = lire_frame(proc, taille)
        if frame is None:
            break
        rgb = frame.reshape(h, l, 3).astype(np.int16)
        gris = rgb.mean(axis=2)
        masque = np.abs(gris - fond) > SEUIL_DIFF
        rgb = rgb.astype(np.uint8)

        # corps : surlignage rouge
        rouge = np.zeros_like(rgb)
        rouge[:, :, 0] = 255
        rgb[masque] = (0.45 * rouge[masque] + 0.55 * rgb[masque]).astype(np.uint8)

        if int(masque.sum()) >= TAILLE_MIN_MASQUE:
            lignes = np.nonzero(masque.any(axis=1))[0]
            for q_i, quantile in enumerate(QUANTILES):
                nb_bas = max(1, int(len(lignes) * quantile))
                bas = lignes[-nb_bas:]
                pieds_y = int(np.median(bas))
                positions[q_i].append(float(pieds_y))
                fiables[q_i].append(True)
                couleur = COULEURS[q_i]
                y0 = max(0, pieds_y - 2)
                y1 = min(h, pieds_y + 3)
                rgb[y0:y1, max(0, l // 2 - 40): l // 2 + 40] = couleur
                # carré au centroïde du bas du masque
                centre_x = int(np.nonzero(masque[bas[-1]])[0].mean())
                rgb[max(0, pieds_y - 4): pieds_y + 5, max(0, centre_x - 6): centre_x + 7] = couleur
        else:
            for q_i in range(len(QUANTILES)):
                positions[q_i].append(positions[q_i][-1] if positions[q_i] else float(h))
                fiables[q_i].append(False)
            rgb[max(0, h - 4):, :, :] = (255, 60, 60)

        try:
            encodeur.stdin.write(rgb.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit(
                "Échec d'encodage : fermez le lecteur vidéo qui lit les anciennes "
                "vidéos de vérification, puis relancez (le nom de sortie inclut "
                "maintenant les quantiles testés)."
            )
        n += 1
    proc.wait()
    encodeur.stdin.close()
    code = encodeur.wait()
    if code != 0:
        raise SystemExit("Échec de l'encodage.")

    print(f"\nVidéo : {sortie}")
    rappel = " | ".join(
        f"{'VERT' if i == 0 else 'CYAN'} = quantile {int(q * 100)} %" for i, q in enumerate(QUANTILES)
    )
    print(f"Rappel : {rappel} | rouge = corps\n")

    # Statistiques par fenêtre
    pos = [np.array(p) for p in positions]
    for nom, (debut, fin) in FENETRES.items():
        ligne = f"{nom:32s} |"
        for q_i, quantile in enumerate(QUANTILES):
            morceau = pos[q_i][debut:fin]
            ligne += f" q{int(quantile * 100)} % : {morceau.mean():7.1f} px (min {morceau.min():.0f}, max {morceau.max():.0f}) |"
        print(ligne)

    # Différence moyenne entre les deux positions
    if len(pos[0]) == len(pos[1]) and len(pos[0]) > 0:
        diff = pos[1] - pos[0]
        print(f"\nDifférence cyan - vert : moyenne {diff.mean():+.1f} px | médiane {np.median(diff):+.1f} px | max {diff.max():+.1f} px")


if __name__ == "__main__":
    main()
