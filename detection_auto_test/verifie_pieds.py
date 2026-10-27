"""
Étape 1 du processus — VÉRIFICATION VISUELLE.

1. Détecte le corps : masque de mouvement par soustraction de fond
   (fond = médiane temporelle sur frames échantillonnées).
2. Isole les pieds : bas du masque (les QUANTILE_PIED lignes les plus
   basses, médiane) — MÊME logique que detect_frames.py.
3. Rend la vidéo annotée à la résolution originale :
   - corps détecté surligné en rouge translucide ;
   - position des pieds marquée : ligne verte horizontale + point au
     centroïde du bas du masque ;
   - si le sujet est perdu (masque trop petit) : ligne rouge.

→ Ouvrez verification_pieds.mp4 : la ligne verte doit coller aux pieds
  quand ils sont au sol, et MONTER avec eux pendant les vols. Si elle
  reste au niveau du sol pendant un vol, le suivi attrape l'ombre.
"""

import io
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
import imageio_ffmpeg

# ============================ Paramètres ============================

VIDEO_DEFAUT = "WhatsApp Video 2026-10-27 at 14.29.28.mp4"
SEUIL_DIFF = 25              # écart au fond = pixel du sujet (idem detect_frames)
QUANTILE_PIED = 0.02         # bas du masque retenu (idem detect_frames)
NB_ECHANTILLONS_FOND = 64    # frames pour la médiane du fond
TAILLE_MIN_MASQUE = 50       # en dessous : sujet considéré perdu

# ====================================================================


def ffmpeg_exe() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_video(exe: str, chemin: Path) -> dict:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    fps_match = re.search(r"([\d.]+) fps", r.stderr)
    return {"fps_lecture": float(fps_match.group(1)) if fps_match else 30.0}


def demarrer_decodage_couleur(exe: str, chemin: Path):
    """Pipe rawvideo RGB24 à la résolution originale (autoration appliquée)."""
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
    infos = probe_video(exe, chemin)
    fps = infos["fps_lecture"]
    print(f"Vidéo : {chemin.name} | fps lecture {fps}")

    # ----- Passe 1 : comptage + fond (médiane, en niveaux de gris) -----
    proc, l, h = demarrer_decodage_couleur(exe, chemin)
    taille = l * h * 3
    total = 0
    while lire_frame(proc, taille) is not None:
        total += 1
    proc.wait()
    pas = max(1, total // NB_ECHANTILLONS_FOND)

    proc, l, h = demarrer_decodage_couleur(exe, chemin)
    echantillons = []
    n = 0
    while True:
        frame = lire_frame(proc, taille)
        if frame is None:
            break
        if n % pas == 0:
            rgb = frame.reshape(h, l, 3)
            echantillons.append(rgb.mean(axis=2))
        n += 1
    proc.wait()
    fond = np.median(np.stack(echantillons), axis=0).astype(np.int16)
    print(f"{total} frames, résolution {l}x{h}, fond construit sur {len(echantillons)} échantillons")

    # ----- Passe 2 : masque + annotation + encodage -----
    sortie = chemin.parent / "verification_pieds.mp4"
    encodeur = subprocess.Popen(
        [
            exe, "-v", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", str(fps),
            "-i", "-",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-crf", "23", "-movflags", "+faststart",
            str(sortie),
        ],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    proc, _, _ = demarrer_decodage_couleur(exe, chemin)
    precedente_pieds = None
    perdus = 0
    n = 0
    while True:
        frame = lire_frame(proc, taille)
        if frame is None:
            break
        rgb = frame.reshape(h, l, 3).astype(np.int16)
        gris = rgb.mean(axis=2)
        masque = np.abs(gris - fond) > SEUIL_DIFF

        rgb = rgb.astype(np.uint8)

        # 1) Corps : surlignage rouge translucide sur tout le masque
        rouge = np.zeros_like(rgb)
        rouge[:, :, 0] = 255
        rgb[masque] = (0.45 * rouge[masque] + 0.55 * rgb[masque]).astype(np.uint8)

        # 2) Pieds : bas du masque (quantile), ligne + point
        nb_pixels = int(masque.sum())
        if nb_pixels >= TAILLE_MIN_MASQUE:
            lignes = np.nonzero(masque.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * QUANTILE_PIED))
            bas = lignes[-nb_bas:]
            pieds_y = int(np.median(bas))
            colonnes = np.nonzero(masque[bas[-1]] | masque[bas[len(bas) // 2]])[0]
            centre_x = int(colonnes.mean()) if len(colonnes) > 0 else l // 2
            couleur = (60, 255, 60)
            rgb[pieds_y, :, :] = couleur
            y0 = max(0, pieds_y - 3)
            y1 = min(h, pieds_y + 4)
            rgb[y0:y1, max(0, centre_x - 6): centre_x + 7] = couleur
            precedente_pieds = pieds_y
        else:
            perdus += 1
            if precedente_pieds is not None:
                rgb[precedente_pieds, :, :] = (255, 60, 60)

        encodeur.stdin.write(rgb.tobytes())
        n += 1
    proc.wait()
    encodeur.stdin.close()
    code = encodeur.wait()
    if code != 0:
        raise SystemExit("L'encodage de la vidéo annotée a échoué.")

    print(f"\nVidéo annotée : {sortie}")
    print(f"{perdus} frame(s) avec sujet perdu (masque < {TAILLE_MIN_MASQUE} px)")
    print("Vérifiez : ligne verte = position des pieds suivie ; rouge = corps détecté.")
    print("Pendant les vols, la ligne verte doit MONTER avec les pieds.")


if __name__ == "__main__":
    main()
