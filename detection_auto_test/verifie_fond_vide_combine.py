"""
FOND VIDE + COMBINAISON des deux filtres : luminance (précis) et
chromaticité normalisée (anti-ombre).

Mesures sur cette vidéo (fond vide de référence) :
  - ombre portée : écart au fond 26-30 niveaux de gris, plus SOMBRE,
    chromaticité proche du sol éclairé ;
  - chaussure/athlète : écart 67-105, chromaticité différente.

RÈGLE COMBINÉE — un pixel appartient au sujet si :
  (A) |écart de luminance| > SEUIL_FORT (60)          -> l'athlète net
  OU (B) |écart de luminance| > SEUIL_FAIBLE (25)      -> l'athlète modéré
      ET (plus clair que le fond OU chromaticité différente)

L'ombre (26-30, plus sombre, chroma proche) échoue en (A) (trop faible)
et en (B) (ni plus claire ni chromatiquement différente) : elle est
exclue. La précision vient du critère de luminance ; la chromaticité ne
sert qu'à rattraper les pixels modérés que l'ombre ne peut imiter.

Pieds = bas du masque (quantile 2 %). Sortie :
verification_fond_vide_combine.mp4 (corps rouge, pieds verts) + analyse.
"""

import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
SEUIL_FORT = 60.0       # branche (A) : luminance très différente
SEUIL_FAIBLE = 25.0     # branche (B) : luminance modérément différente
SEUIL_CHROMA = 0.05     # branche (B) : écart de chromaticité
SEUIL_SOMME_MIN = 15.0  # R+G+B en dessous : chromaticité instable, exclue de (B)
SEUIL_VIDE = 3.0        # écart moyen (gris) au-dessus = athlète entré
MAX_FRAMES_VIDES = 1500
QUANTILE_PIED = 0.02
TAILLE_MIN_MASQUE = 50
POURCENT_SOL = 90.0
RAYON = 3

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


def chromaticite(rgb: np.ndarray):
    """(r', g', stable) — chromaticité normalisée par la somme des canaux."""
    f = rgb.astype(np.float32)
    somme = f[:, :, 0] + f[:, :, 1] + f[:, :, 2]
    stable = somme > SEUIL_SOMME_MIN
    sure = np.maximum(somme, 1.0)
    return f[:, :, 0] / sure, f[:, :, 1] / sure, stable


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    infos = probe(exe, chemin)
    fps = infos["fps"]
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps | durée {infos.get('duree', 0):.1f} s")

    # -------- Phase 1 : phase vide + fond (luminance ET chromaticité) --------
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    assert proc.stdout is not None
    taille = l * h * 3
    grises: list[np.ndarray] = []
    echant_r: list[np.ndarray] = []
    echant_g: list[np.ndarray] = []
    premiere = None
    n = 0
    while n < MAX_FRAMES_VIDES:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.int16)
        if premiere is None:
            premiere = gris
        elif float(np.abs(gris - premiere).mean()) > SEUIL_VIDE:
            break
        if n < 300:
            grises.append(gris)
            r, g, stable = chromaticite(rgb)
            echant_r.append(np.where(stable, r, np.nan))
            echant_g.append(np.where(stable, g, np.nan))
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()

    frames_vides = n
    if len(grises) < 3:
        raise SystemExit("Phase vide non détectée (moins de 3 frames sans athlète).")
    fond_gris = np.median(np.stack(grises), axis=0).astype(np.int16)
    fond_r = np.nanmedian(np.stack(echant_r), axis=0)
    fond_g = np.nanmedian(np.stack(echant_g), axis=0)
    fond_b = np.clip(1.0 - fond_r - fond_g, 0.0, 1.0)
    print(
        f"Phase vide : {frames_vides} frames ({frames_vides / fps:.2f} s) — "
        f"fond = luminance + chromaticité médianes de {len(grises)} frames"
    )

    # -------- Phase 2 : masque combiné + trajectoire + rendu --------
    largeur_out = (l * 3 // 2) + (l * 3 // 2) % 2
    hauteur_out = (h * 3 // 2) + (h * 3 // 2) % 2
    sortie = chemin.parent / "verification_fond_vide_combine.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", "30",
         "-i", "-",
         "-vf", f"scale={largeur_out}:{hauteur_out}",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    positions: list[float] = []
    fiables: list[float] = []
    perdus = 0
    stats_branches = [0, 0]  # pixels (A) et (B) cumulés sur frames test
    n = 0
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.int16)
        r, g, stable = chromaticite(rgb)
        b = np.clip(1.0 - r - g, 0.0, 1.0)

        diff_gris = np.abs(gris - fond_gris)
        signe_gris = gris - fond_gris  # > 0 : plus clair que le fond
        with np.errstate(invalid="ignore"):
            diff_chroma = np.maximum(
                np.maximum(np.abs(r - fond_r), np.abs(g - fond_g)),
                np.abs(b - fond_b),
            )
        utilisable_chroma = stable & np.isfinite(fond_r) & np.isfinite(fond_g)

        branche_a = diff_gris > SEUIL_FORT
        branche_b = (
            (diff_gris > SEUIL_FAIBLE)
            & (signe_gris > 0)
        ) | (
            (diff_gris > SEUIL_FAIBLE)
            & utilisable_chroma
            & (diff_chroma > SEUIL_CHROMA)
        )
        masque = branche_a | branche_b

        if n in (3840, 3980, 4350, 4390):
            stats_branches[0] += int(branche_a.sum())
            stats_branches[1] += int((branche_b & ~branche_a).sum())

        if int(masque.sum()) >= TAILLE_MIN_MASQUE:
            lignes = np.nonzero(masque.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * QUANTILE_PIED))
            bas = lignes[-nb_bas:]
            pieds_y = int(np.median(bas))
            colonnes = np.nonzero(masque[bas[len(bas) // 2]] | masque[bas[-1]])[0]
            centre_x = int(colonnes.mean()) if len(colonnes) > 0 else l // 2
            positions.append(float(pieds_y))
            fiables.append(1.0)
        else:
            perdus += 1
            positions.append(positions[-1] if positions else float(h))
            fiables.append(0.0)
            pieds_y = None
            centre_x = l // 2

        # Rendu : corps rouge + pieds verts
        rgb16 = rgb.astype(np.int16)
        rouge = np.zeros_like(rgb16)
        rouge[:, :, 0] = 255
        rgb16[masque] = (0.45 * rouge[masque] + 0.55 * rgb16[masque]).astype(np.int16)
        rgb8 = rgb16.astype(np.uint8)

        if pieds_y is not None and 0 <= pieds_y < h:
            couleur = (60, 255, 60)
            rgb8[max(0, pieds_y - RAYON): pieds_y + RAYON + 1, l // 4:, :] = couleur
            rgb8[
                max(0, pieds_y - 6): pieds_y + 7,
                max(0, centre_x - 8): centre_x + 9,
            ] = couleur

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
    print(f"\n{n} frames analysées | {perdus} frame(s) sans sujet détecté")
    print(
        f"Pixels du masque (4 frames test) : branche (A) luminance forte = {stats_branches[0]}, "
        f"branche (B) modérée+claire/colorée = {stats_branches[1]}"
    )
    print(f"Vidéo résultat : {sortie}")

    # -------- Analyse --------
    pieds = np.array(positions)
    fiab = np.array(fiables)
    lissee = d.mediane_glissante(pieds, d.FENETRE_LISSAGE)

    fiables_idx = np.nonzero(fiab > 0)[0]
    if len(fiables_idx) == 0:
        raise SystemExit("Aucune frame avec sujet détecté.")
    debut = int(fiables_idx[0])
    fin = len(lissee)
    fenetre = lissee[debut:fin]
    fiab_fenetre = fiab[debut:fin]
    positions_fiables = fenetre[fiab_fenetre > 0]
    print(f"Analyse : frames {debut + 1} à {fin}")

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

    print(f"\nLigne de sol (quantile {POURCENT_SOL:.0f} %) : {sol:.1f} px | seuil : {seuil:.1f} px")
    print(f"Amplitude : {amplitude:.0f} px (min {positions_fiables.min():.0f}, max {positions_fiables.max():.0f})")
    if vols_profondeur:
        profondeurs = [sol - s for _, s in vols_profondeur]
        print(
            f"{len(vols_profondeur)} vols complets — élévation moyenne au-dessus du sol : "
            f"{np.mean(profondeurs):.0f} px (min {np.min(profondeurs):.0f}, max {np.max(profondeurs):.0f})"
        )
    print(f"\n{len(evenements)} bascule(s) détectée(s) :")
    for ev in evenements:
        print(f"  frame {ev['frame'] + 1:>6} | {ev['frame'] / fps:7.3f} s | {ev['direction']}")

    # Graphique
    fig, ax = plt.subplots(figsize=(14, 5), dpi=120)
    idx = np.arange(len(lissee))
    ax.plot(idx, pieds, color="#9aa1b5", alpha=0.35, linewidth=0.8, label="position brute")
    ax.plot(idx, lissee, color="#4d9fff", linewidth=1.5, label="position lissée")
    ax.axhline(sol, color="#e6a23c", linewidth=1.2, label="ligne de sol")
    ax.axhline(seuil, color="#e94560", linestyle="--", linewidth=1.2, label="seuil")
    for ev in evenements:
        ax.axvline(ev["frame"], color="#2ecc71", linewidth=1.1, alpha=0.85)
    ax.axvspan(0, frames_vides, color="#2ecc71", alpha=0.12)
    ax.invert_yaxis()
    ax.set_xlabel("frame")
    ax.set_ylabel("position verticale des pieds (px)")
    ax.set_title(
        f"{chemin.name} — fond vide + filtre COMBINÉ "
        f"(luminance forte OU modérée-claire/colorée) | phase vide {frames_vides} frames"
    )
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_fond_vide_combine.png")
    print("Graphique : trajectoire_fond_vide_combine.png")


if __name__ == "__main__":
    main()
