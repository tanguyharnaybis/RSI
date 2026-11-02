"""
SUIVI DU PIED PAR MODÈLE DE COULEUR (idée utilisateur).

1. Le masque du pied à la frame de contact (3983) est régénéré par SAM 2
   (clic sur le pied — comme sam2_demo_frame_3983.png, masque vert).
2. MODÈLE DE COULEUR : tous les pixels RGB du masque sont quantifiés
   (32 niveaux/canal) dans une table 3D ; la table est DILATÉE d'un bin
   dans chaque dimension → tolérance aux petites variations d'éclairage.
3. Sur CHAQUE frame : les pixels dont la couleur tombe dans la table
   sont marqués (vert) ; petits fragments supprimés ; le bas du pied =
   quantile 2 % des lignes marquées. Le pied peut être perdu en vol :
   pas grave, l'objectif est la détection des APPUIS.
4. Sortie : verification_couleur_pied.mp4 (vert = correspondances couleur,
   marqueur du bas, référence cyan), couleur_pied.json, analyse
   (croisements, contacts détectés vs référence).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image
from scipy import ndimage
import imageio_ffmpeg

import detect_frames as d

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
CHECKPOINT = "sam2.1_hiera_tiny.pt"
CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"
FRAME_MASQUE = 3983       # frame de contact dont le pied sert de modèle
X_PIED = 166              # clic SAM 2 sur le pied
DECALAGE_Y_PIED = 10
SEUIL_VIDE = 3.0
NB_FRAMES_FOND = 30

BINS = 32                 # niveaux de quantification par canal RGB
TOLERANCE_BINS = 1        # dilatation de la table de couleurs (bins)
MIN_COMPOSANTE = 100      # fragments plus petits supprimés
QUANTILE_PIED = 0.02
POURCENT_SOL = 90.0
RAYON = 3

COULEUR_PIED = (60, 255, 60)      # vert : correspondances couleur
COULEUR_REFERENCE = (60, 200, 255)  # cyan : référence fond vide

# -------------------------------------------------------


def probe(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def demarrer_decodage_originale(exe: str, chemin: Path, max_frames: int | None = None):
    import io

    args = [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0"]
    if max_frames:
        args += ["-frames:v", str(max_frames)]
    args += ["-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    image.close()
    proc = subprocess.Popen(args, stdout=subprocess.PIPE)
    return proc, l, h


def indice_quantifie(rgb: np.ndarray, bins: int) -> np.ndarray:
    """Quantifie une image RGB (h, l, 3) en indices de table (h, l)."""
    q = (rgb >> (8 - 5)) if False else None
    decalage = 8 - 5
    # 32 bins sur 0-255 : valeur >> 3
    r = rgb[:, :, 0] >> 3
    g = rgb[:, :, 1] >> 3
    b = rgb[:, :, 2] >> 3
    return (r * bins + g) * bins + b


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    fps = probe(exe, chemin)
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps")

    # ---------------- Frame modèle + masque SAM 2 ----------------
    proc, l, h = demarrer_decodage_originale(exe, chemin, max_frames=FRAME_MASQUE + 2)
    assert proc.stdout is not None
    taille = l * h * 3
    frame_modele = None
    n = 0
    while n <= FRAME_MASQUE:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        if n == FRAME_MASQUE:
            frame_modele = np.frombuffer(buf, np.uint8).reshape(h, l, 3).copy()
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if frame_modele is None:
        raise SystemExit("Frame modèle non trouvée.")

    donnees_ref = json.load(open("iso_sobel_video.json", encoding="utf-8"))
    y_bas = donnees_ref["reference"][FRAME_MASQUE]
    print(f"Frame modèle {FRAME_MASQUE + 1} : bas du pied mesuré y={y_bas:.0f}")

    print("SAM 2 : masque du pied sur la frame modèle…")
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    modele = build_sam2(CONFIG, CHECKPOINT, device="cpu")
    predicteur = SAM2ImagePredictor(modele)
    predicteur.set_image(frame_modele)
    masques, scores, _ = predicteur.predict(
        point_coords=np.array([[X_PIED, y_bas - DECALAGE_Y_PIED]], dtype=np.float32),
        point_labels=np.array([1]),
        multimask_output=False,
    )
    masque_pied = masques[0] > 0.5
    print(f"Masque SAM 2 : {int(masque_pied.sum())} px | score {scores[0]:.2f}")

    # ---------------- Table de couleurs du pied ----------------
    pixels_pied = frame_modele[masque_pied]          # (N, 3) uint8
    table = np.zeros((BINS, BINS, BINS), dtype=bool)
    q = pixels_pied >> 3                              # 32 bins/canal
    table[q[:, 0], q[:, 1], q[:, 2]] = True
    table_plate = ndimage.binary_dilation(
        table, structure=np.ones((3, 3, 3), bool), iterations=TOLERANCE_BINS
    )
    print(
        f"Modèle de couleur : {len(pixels_pied)} pixels du pied → "
        f"{int(table.sum())} bins remplis, {int(table_plate.sum())} avec tolérance"
    )

    # ---------------- Passe unique : correspondances + rendu ----------------
    sortie = chemin.parent / "verification_couleur_pied.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", "30",
         "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    structure = ndimage.generate_binary_structure(2, 2)
    positions: list[float] = []
    fiables: list[float] = []
    tailles: list[int] = []
    perdues = 0

    n = 0
    proc, l, h = demarrer_decodage_originale(exe, chemin)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)

        # correspondance couleur
        r = rgb[:, :, 0] >> 3
        g = rgb[:, :, 1] >> 3
        b = rgb[:, :, 2] >> 3
        correspond = table_plate[r, g, b]

        # nettoyage
        etiquettes, nb = ndimage.label(correspond, structure=structure)
        propre = np.zeros_like(correspond)
        if nb > 0:
            tailles_comp = ndimage.sum_labels(
                np.ones_like(etiquettes), etiquettes, np.arange(1, nb + 1)
            )
            propre = np.isin(etiquettes, np.nonzero(tailles_comp >= MIN_COMPOSANTE)[0] + 1)

        if int(propre.sum()) >= MIN_COMPOSANTE:
            lignes = np.nonzero(propre.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * QUANTILE_PIED))
            bas = lignes[-nb_bas:]
            pieds_y = int(np.median(bas))
            positions.append(float(pieds_y))
            fiables.append(1.0)
            tailles.append(int(propre.sum()))
        else:
            perdues += 1
            positions.append(positions[-1] if positions else float(h))
            fiables.append(0.0)
            tailles.append(0)
            pieds_y = None

        # rendu : vert translucide sur les correspondances
        rgb16 = rgb.astype(np.int16)
        verte = np.zeros_like(rgb16)
        verte[:, :] = COULEUR_PIED
        rgb16[propre] = (0.55 * verte[propre] + 0.45 * rgb16[propre]).astype(np.int16)
        rgb8 = rgb16.astype(np.uint8)

        if pieds_y is not None and 0 <= pieds_y < h:
            rgb8[max(0, pieds_y - RAYON): pieds_y + RAYON + 1, l // 4:, :] = COULEUR_PIED
        yr = int(donnees_ref["reference"][n]) if n < len(donnees_ref["reference"]) else 0
        if 0 <= yr < h:
            rgb8[max(0, yr - 1): yr + 2, : l // 5, :] = COULEUR_REFERENCE

        try:
            encodeur.stdin.write(rgb8.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit("Échec d'encodage : fermez le lecteur des anciennes vidéos.")
        n += 1
    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage.")
    print(f"\n{n} frames | pied détecté sur {n - perdues} frames | perdu (vol ?) sur {perdues}")
    print(f"Vidéo résultat : {sortie}")
    print("Rappel : vert = pixels correspondant aux couleurs du pied ; cyan = référence")

    # ---------------- Analyse ----------------
    pieds = np.array(positions)
    fiab = np.array(fiables, dtype=float)
    lissee = d.mediane_glissante(pieds, d.FENETRE_LISSAGE)

    with open(chemin.parent / "couleur_pied.json", "w", encoding="utf-8") as f:
        json.dump(
            {"positions": [round(p, 1) for p in pieds], "fiables": fiables,
             "tailles": tailles, "frame_modele": FRAME_MASQUE},
            f, ensure_ascii=False,
        )
    print("Données : couleur_pied.json")

    fiables_idx = np.nonzero(fiab > 0)[0]
    if len(fiables_idx) == 0:
        raise SystemExit("Pied jamais détecté.")
    debut = int(fiables_idx[0])
    fenetre = lissee[debut:]
    fiab_fenetre = fiab[debut:]
    positions_fiables = fenetre[fiab_fenetre > 0]

    sol = float(np.percentile(positions_fiables, POURCENT_SOL))
    amplitude = float(positions_fiables.max() - positions_fiables.min())
    deltas = np.abs(np.diff(fenetre))
    en_vol = fenetre[1:] < sol - 0.1 * amplitude
    bruit = float(np.median(deltas[en_vol])) if en_vol.sum() >= 8 else 1.0
    epsilon = max(2 * bruit, 0.02 * amplitude, 1.0)
    seuil = sol - epsilon

    seuils = fenetre >= seuil
    evenements: list[dict] = []
    precedent = seuils[0]
    for i in range(1, len(seuils)):
        if seuils[i] != precedent:
            evenements.append(
                {
                    "frame": debut + i,
                    "direction": "descente (vers le sol)" if seuils[i] else "montée (quitte le sol)",
                }
            )
            precedent = seuils[i]
    if evenements:
        fusionnes = [evenements[0]]
        for ev in evenements[1:]:
            if ev["frame"] - fusionnes[-1]["frame"] < d.SEGMENT_MIN_FRAMES:
                fusionnes[-1] = ev
            else:
                fusionnes.append(ev)
        evenements = fusionnes

    print(f"\nLigne de sol : {sol:.1f} px | seuil : {seuil:.1f} px")
    print(f"{len(evenements)} bascule(s) :")
    for ev in evenements:
        print(f"  frame {ev['frame'] + 1:>6} | {ev['frame'] / fps:7.3f} s | {ev['direction']}")

    # Graphique
    fig, ax = plt.subplots(figsize=(14, 5), dpi=120)
    idx = np.arange(len(lissee))
    ax.plot(idx, pieds, color="#9aa1b5", alpha=0.3, linewidth=0.8, label="position brute")
    ax.plot(idx, lissee, color="#4d9fff", linewidth=1.6, label="position lissée (couleur du pied)")
    ref = np.array(donnees_ref["reference"])[: len(idx)]
    ax.plot(idx, ref, color="#ff9a3c", linewidth=1.2, alpha=0.9, label="référence fond vide (seuil 60)")
    ax.axhline(sol, color="#e6a23c", linewidth=1.1, label="ligne de sol")
    for ev in evenements:
        ax.axvline(ev["frame"], color="#2ecc71", linewidth=1.0, alpha=0.7)
    ax.invert_yaxis()
    ax.set_xlabel("frame")
    ax.set_ylabel("position du bas du pied (px)")
    ax.set_title(f"{chemin.name} — suivi par couleur du pied (modèle frame {FRAME_MASQUE + 1})")
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_couleur_pied.png")
    print("Graphique : trajectoire_couleur_pied.png")


if __name__ == "__main__":
    main()
