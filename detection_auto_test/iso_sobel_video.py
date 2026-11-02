"""
SOBEL PLEINE IMAGE - FOND SOBEL SOUSTRAIT — sur TOUTE la vidéo (idée
utilisateur), même traitement que les images overlay_iso_sobel_frame_X
validées.

Pipeline par frame (à la résolution ORIGINALE 464x832) :
1. contours de la frame : magnitude de Sobel > SEUIL_SOBEL ;
2. soustraction des contours du fond (précalculés une fois, dilatés de
   DILATATION_FOND px) ;
3. nettoyage : fragments de contours < MIN_FRAGMENT px supprimés ;
4. bas du pied = quantile 2 % des lignes des contours isolés ;
5. rendu : contours isolés en rouge (comme les images validées),
   marqueur du bas du pied en vert, référence fond-vide (seuil 60) en cyan.

Sorties : verification_iso_sobel.mp4, iso_sobel_video.json,
trajectoire_iso_sobel.png + analyse (ligne de sol, bascules, vols).
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
NB_FRAMES_FOND = 30
SEUIL_VIDE = 3.0
SEUIL_SOBEL = 300.0      # magnitude de gradient = contour (validée)
DILATATION_FOND = 2      # dilatation des contours du fond (tolérance)
MIN_FRAGMENT = 25        # fragments plus petits supprimés
QUANTILE_PIED = 0.02     # bas des contours isolés retenu
TAILLE_MIN_MASQUE = 50   # en dessous : pas de pied détecté
SEUIL_REFERENCE = 60.0   # référence fond vide (seuil fort validé)
POURCENT_SOL = 90.0
RAYON = 3

COULEUR_CONTOURS = (255, 60, 60)   # rouge : contours isolés (comme les images)
COULEUR_PIED = (60, 255, 60)      # vert : bas du pied
COULEUR_REFERENCE = (60, 200, 255)  # cyan : référence fond vide

# -------------------------------------------------------


def probe(exe: str, chemin: Path) -> dict:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    infos = {"fps": float(m.group(1)) if m else 0.0}
    if dur:
        h, mn, s = dur.groups()
        infos["duree"] = int(h) * 3600 + int(mn) * 60 + float(s)
    return infos


def magnitude_sobel(gris: np.ndarray) -> np.ndarray:
    f = gris.astype(np.float32)
    gx = ndimage.sobel(f, axis=1, mode="nearest")
    gy = ndimage.sobel(f, axis=0, mode="nearest")
    return np.sqrt(gx * gx + gy * gy)


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


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    infos = probe(exe, chemin)
    fps = infos["fps"]
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps | durée {infos.get('duree', 0):.1f} s")

    # ---------------- Fond + contours du fond (précalculés) ----------------
    proc, l, h = demarrer_decodage_originale(exe, chemin, max_frames=400)
    assert proc.stdout is not None
    taille = l * h * 3
    frames_fond = []
    premiere = None
    n = 0
    while n < NB_FRAMES_FOND:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        gris = np.frombuffer(buf, np.uint8).reshape(h, l, 3).mean(axis=2)
        if premiere is None:
            premiere = gris.astype(np.int16)
        elif float(np.abs(gris.astype(np.int16) - premiere).mean()) > SEUIL_VIDE:
            break
        frames_fond.append(gris.astype(np.uint8))
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if len(frames_fond) < 3:
        raise SystemExit("Phase vide non détectée.")

    fond = np.median(np.stack(frames_fond), axis=0).astype(np.uint8)
    fond16 = fond.astype(np.int16)
    contours_fond = magnitude_sobel(fond) > SEUIL_SOBEL
    contours_fond_dil = ndimage.binary_dilation(contours_fond, iterations=DILATATION_FOND)
    print(
        f"Fond : médiane de {len(frames_fond)} frames | {l}x{h} | "
        f"contours du fond : {int(contours_fond.sum())} px (soustraits chaque frame)"
    )

    # ---------------- Encodage ----------------
    sortie = chemin.parent / "verification_iso_sobel.mp4"
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
    reference: list[float] = []
    iso_px_moyens = 0.0
    echantillons = 0

    n = 0
    proc, l, h = demarrer_decodage_originale(exe, chemin)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.uint8)

        # ---- contours isolés (comme les images validées) ----
        aretes = magnitude_sobel(gris) > SEUIL_SOBEL
        nouvelles = aretes & ~contours_fond_dil
        etiquettes, nb = ndimage.label(nouvelles, structure=structure)
        iso = np.zeros_like(nouvelles)
        if nb > 0:
            tailles = ndimage.sum_labels(np.ones_like(etiquettes), etiquettes, np.arange(1, nb + 1))
            iso = np.isin(etiquettes, np.nonzero(tailles >= MIN_FRAGMENT)[0] + 1)

        if int(iso.sum()) >= TAILLE_MIN_MASQUE:
            lignes = np.nonzero(iso.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * QUANTILE_PIED))
            pieds_y = int(np.median(lignes[-nb_bas:]))
            positions.append(float(pieds_y))
            fiables.append(1.0)
            if n % 50 == 0:
                iso_px_moyens += int(iso.sum())
                echantillons += 1
        else:
            positions.append(positions[-1] if positions else float(h))
            fiables.append(0.0)
            pieds_y = None

        # ---- référence : fond vide seuil 60 (même frame, résolution identique) ----
        masque_ref = np.abs(gris.astype(np.int16) - fond16) > SEUIL_REFERENCE
        if int(masque_ref.sum()) >= 50:
            lignes_r = np.nonzero(masque_ref.any(axis=1))[0]
            nb_bas_r = max(1, int(len(lignes_r) * QUANTILE_PIED))
            reference.append(float(np.median(lignes_r[-nb_bas_r:])))
        else:
            reference.append(reference[-1] if reference else float(h))

        # ---- rendu ----
        rgb16 = rgb.astype(np.int16)
        teinte = np.zeros_like(rgb16)
        teinte[:, :] = COULEUR_CONTOURS
        rgb16[iso] = (0.55 * teinte[iso] + 0.45 * rgb16[iso]).astype(np.int16)
        rgb8 = rgb16.astype(np.uint8)

        if pieds_y is not None and 0 <= pieds_y < h:
            rgb8[max(0, pieds_y - RAYON): pieds_y + RAYON + 1, l // 4:, :] = COULEUR_PIED
            rgb8[max(0, pieds_y - 6): pieds_y + 7, l // 2 - 8: l // 2 + 9, :] = COULEUR_PIED
        yr = int(reference[-1])
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
    print(f"\n{n} frames | {int(sum(1 for f in fiables if f == 0))} frame(s) sans contours exploitables")
    if echantillons:
        print(f"Contours isolés : {int(iso_px_moyens / echantillons)} px/frame en moyenne (1 frame sur 50)")
    print(f"Vidéo résultat : {sortie}")
    print("Rappel : rouge = contours isolés (hors fond) ; vert = bas du pied ;")
    print("  cyan (quint gauche) = référence fond vide seuil 60")

    # ---------------- Analyse ----------------
    pieds = np.array(positions)
    fiab = np.array(fiables, dtype=float)
    lissee = d.mediane_glissante(pieds, d.FENETRE_LISSAGE)

    with open(chemin.parent / "iso_sobel_video.json", "w", encoding="utf-8") as f:
        json.dump(
            {
                "positions": [round(p, 1) for p in pieds],
                "fiables": fiables,
                "reference": [round(r, 1) for r in reference],
                "parametres": {
                    "seuil_sobel": SEUIL_SOBEL,
                    "dilatation_fond": DILATATION_FOND,
                    "min_fragment": MIN_FRAGMENT,
                    "quantile_pied": QUANTILE_PIED,
                },
            },
            f, ensure_ascii=False,
        )
    print("Données : iso_sobel_video.json")

    fiables_idx = np.nonzero(fiab > 0)[0]
    if len(fiables_idx) == 0:
        raise SystemExit("Aucune frame exploitable.")
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

    vols_profondeur = []
    for i in range(len(evenements) - 1):
        a, b_ev = evenements[i], evenements[i + 1]
        if a["direction"].startswith("mont") and b_ev["direction"].startswith("desc"):
            sommet = fenetre[a["frame"] - debut: b_ev["frame"] - debut].min()
            vols_profondeur.append((a["frame"], sommet))

    # comparaison avec la référence (fenêtre fiable)
    ref_complete = np.array(reference)
    ref = ref_complete[debut:debut + len(fenetre)]
    lisse_ref = d.mediane_glissante(ref, d.FENETRE_LISSAGE)
    sol_ref = float(np.percentile(lisse_ref, POURCENT_SOL))
    ecart = np.abs(fenetre - lisse_ref[: len(fenetre)])
    en_vol_ref = lisse_ref[: len(fenetre)] < sol_ref - 0.5 * max(1.0, sol_ref - seuil)

    print(f"\nLigne de sol : {sol:.1f} px | seuil : {seuil:.1f} px")
    print(f"Amplitude : {amplitude:.0f} px (min {positions_fiables.min():.0f}, max {positions_fiables.max():.0f})")
    if vols_profondeur:
        profondeurs = [sol - s for _, s in vols_profondeur]
        print(
            f"{len(vols_profondeur)} vols complets — élévation moyenne : "
            f"{np.mean(profondeurs):.0f} px (min {np.min(profondeurs):.0f}, max {np.max(profondeurs):.0f})"
        )
    print(f"\nÉcart moyen avec la référence fond-vide : {ecart.mean():.1f} px (max {ecart.max():.0f})")
    if en_vol_ref.any():
        print(f"  pendant les vols (référence) : {ecart[en_vol_ref].mean():.1f} px")
        print(f"  pendant les contacts : {ecart[~en_vol_ref].mean():.1f} px")

    print(f"\n{len(evenements)} bascule(s) :")
    for ev in evenements:
        print(f"  frame {ev['frame'] + 1:>6} | {ev['frame'] / fps:7.3f} s | {ev['direction']}")

    # Graphique
    fig, ax = plt.subplots(figsize=(14, 5), dpi=120)
    idx = np.arange(len(lissee))
    ax.plot(idx, pieds, color="#9aa1b5", alpha=0.3, linewidth=0.8, label="position brute (contours)")
    ax.plot(idx, lissee, color="#4d9fff", linewidth=1.6, label="position lissée (contours)")
    ax.plot(idx, ref_complete[: len(idx)], color="#ff9a3c", linewidth=1.2, alpha=0.9, label="référence fond vide (seuil 60)")
    ax.axhline(sol, color="#e6a23c", linewidth=1.1, label="ligne de sol (contours)")
    for ev in evenements:
        ax.axvline(ev["frame"], color="#2ecc71", linewidth=1.0, alpha=0.7)
    ax.invert_yaxis()
    ax.set_xlabel("frame")
    ax.set_ylabel("position du bas du pied (px)")
    ax.set_title(f"{chemin.name} — Sobel pleine image - contours du fond soustraits")
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_iso_sobel.png")
    print("Graphique : trajectoire_iso_sobel.png")


if __name__ == "__main__":
    main()
