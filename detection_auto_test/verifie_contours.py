"""
ISOLEMENT DE L'ATHLÈTE : différence de fond (fond vide) + EXTRACTION DE
CONTOURS (idée utilisateur).

Problème visé : le filtre de différence de fond perd les parties de
l'athlète dont la luminance ressemble au fond (ex. chaussettes noires
devant un fond sombre). Mais l'athlète est au PREMIER PLAN : ses contours
sont nets, là où le fond (plus lointain, légèrement flou) a des arêtes
plus faibles — et surtout, les arêtes de l'athlète N'EXISTENT PAS dans
l'image de fond.

Pipeline :
1. Fond vide (médiane des premières frames, décor seul).
2. Filtre 1 : masque_diff = |frame - fond| > SEUIL_DIFF.
3. Filtre 2 : contours = arêtes FORtes (gradient de Sobel) de la frame
   qui ne sont PAS des arêtes du fond (arêtes « nouvelles »), dilatées
   pour fermer la silhouette.
4. masque_final = masque_diff | contours_dilatés, nettoyé des petites
   composantes. Les pixels apportés UNIQUEMENT par les contours sont
   surlignés en cyan dans la vidéo (visualiser où le contour complète).
5. Pieds = bas du masque final (quantile 2 %).
6. Vidéo verification_contours.mp4 + analyse (croisements, vols).
"""

import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import ndimage
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
SEUIL_DIFF = 25.0        # filtre 1 : écart au fond vide
SEUIL_CONTOUR = 50.0     # filtre 2 : magnitude de gradient (Sobel) = arête
DILATATION_CONTOUR = 3   # dilatation des arêtes (ferme la silhouette)
TAILLE_MIN_COMPOSANTE = 150
SEUIL_VIDE = 3.0
MAX_FRAMES_VIDES = 1500
QUANTILE_PIED = 0.02
POURCENT_SOL = 90.0
RAYON = 3

COULEUR_CORPS = (255, 60, 60)     # rouge translucide : silhouette finale
COULEUR_CONTOUR = (60, 230, 255)  # cyan vif : pixels ajoutés par les contours
COULEUR_PIED = (60, 255, 60)      # vert : position des pieds

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


def magnitude_gradient(gris: np.ndarray) -> np.ndarray:
    """Magnitude du gradient de Sobel d'une image en niveaux de gris."""
    f = gris.astype(np.float32)
    gx = ndimage.sobel(f, axis=1, mode="nearest")
    gy = ndimage.sobel(f, axis=0, mode="nearest")
    return np.sqrt(gx * gx + gy * gy)


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    infos = probe(exe, chemin)
    fps = infos["fps"]
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps | durée {infos.get('duree', 0):.1f} s")

    # ---------------- Phase 1 : fond vide + arêtes du fond ----------------
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    assert proc.stdout is not None
    taille = l * h * 3
    grises: list[np.ndarray] = []
    premiere = None
    n = 0
    while n < MAX_FRAMES_VIDES:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        gris = np.frombuffer(buf, np.uint8).reshape(h, l, 3).mean(axis=2).astype(np.int16)
        if premiere is None:
            premiere = gris
        elif float(np.abs(gris - premiere).mean()) > SEUIL_VIDE:
            break
        if n < 300:
            grises.append(gris)
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if len(grises) < 3:
        raise SystemExit("Phase vide non détectée.")
    frames_vides = n
    fond = np.median(np.stack(grises), axis=0).astype(np.int16)

    # Arêtes du fond (une seule fois) : les arêtes « nouvelles » de la frame
    # devront éviter ces zones (dilatées pour tolérer le bruit de compression).
    aretes_fond = magnitude_gradient(fond) > SEUIL_CONTOUR
    aretes_fond_dilatees = ndimage.binary_dilation(aretes_fond, iterations=2)
    print(
        f"Phase vide : {frames_vides} frames — fond prêt | "
        f"arêtes du fond : {int(aretes_fond.sum())} px (exclues des contours)"
    )

    # ---------------- Phase 2 : filtres combinés + rendu ----------------
    largeur_out = (l * 3 // 2) + (l * 3 // 2) % 2
    hauteur_out = (h * 3 // 2) + (h * 3 // 2) % 2
    sortie = chemin.parent / "verification_contours.mp4"
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
    apportes_contour_total = 0
    frames_echantillon = 0
    structure = ndimage.generate_binary_structure(2, 2)

    n = 0
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.int16)

        # ---- Filtre 1 : différence de fond ----
        masque_diff = np.abs(gris - fond) > SEUIL_DIFF

        # ---- Filtre 2 : contours nouveaux ----
        gradient = magnitude_gradient(gris)
        aretes_nouvelles = (gradient > SEUIL_CONTOUR) & ~aretes_fond_dilatees
        contours_dilates = ndimage.binary_dilation(
            aretes_nouvelles, structure, iterations=DILATATION_CONTOUR
        )

        # ---- Silhouette combinée, nettoyée ----
        masque = masque_diff | contours_dilates
        etiquettes, nb = ndimage.label(masque, structure=structure)
        if nb > 0:
            tailles = ndimage.sum_labels(
                np.ones_like(etiquettes), etiquettes, np.arange(1, nb + 1)
            )
            gardes = np.nonzero(tailles >= TAILLE_MIN_COMPOSANTE)[0] + 1
            masque = np.isin(etiquettes, gardes)

        if int(masque.sum()) >= TAILLE_MIN_COMPOSANTE:
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

        # Statistique : pixels apportés uniquement par les contours
        apportes = masque & ~masque_diff
        if n % 50 == 0 and int(masque.sum()) > 0:
            apportes_contour_total += int(apportes.sum())
            frames_echantillon += 1

        # ---- Rendu ----
        rgb16 = rgb.astype(np.int16)
        teinte = np.zeros_like(rgb16)
        teinte[:, :] = COULEUR_CORPS
        rgb16[masque] = (0.45 * teinte[masque] + 0.55 * rgb16[masque]).astype(np.int16)
        # cyan : pixels de la silhouette apportés par les contours
        teinte_c = np.zeros_like(rgb16)
        teinte_c[:, :] = COULEUR_CONTOUR
        rgb16[apportes] = (0.75 * teinte_c[apportes] + 0.25 * rgb16[apportes]).astype(np.int16)
        rgb8 = rgb16.astype(np.uint8)

        if pieds_y is not None and 0 <= pieds_y < h:
            rgb8[
                max(0, pieds_y - RAYON): pieds_y + RAYON + 1,
                l // 4:,
                :,
            ] = COULEUR_PIED
            rgb8[
                max(0, pieds_y - 6): pieds_y + 7,
                max(0, centre_x - 8): centre_x + 9,
            ] = COULEUR_PIED

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
    print(f"\n{n} frames | {perdus} frame(s) sans sujet")
    if frames_echantillon:
        print(
            f"Pixels de silhouette apportés UNIQUEMENT par les contours : "
            f"{apportes_contour_total // frames_echantillon} px/frame en moyenne "
            f"(1 frame sur 50)"
        )
    print(f"Vidéo résultat : {sortie}")
    print("Rappel : rouge = silhouette finale ; cyan = ajouté par les contours ;")
    print("  vert = position des pieds (ligne + carré)")

    # ---------------- Analyse ----------------
    pieds = np.array(positions)
    fiab = np.array(fiables)
    lissee = d.mediane_glissante(pieds, d.FENETRE_LISSAGE)

    fiables_idx = np.nonzero(fiab > 0)[0]
    if len(fiables_idx) == 0:
        raise SystemExit("Aucune frame avec sujet détecté.")
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

    print(f"\nLigne de sol : {sol:.1f} px | seuil : {seuil:.1f} px")
    print(f"Amplitude : {amplitude:.0f} px (min {positions_fiables.min():.0f}, max {positions_fiables.max():.0f})")
    if vols_profondeur:
        profondeurs = [sol - s for _, s in vols_profondeur]
        print(
            f"{len(vols_profondeur)} vols complets — élévation moyenne : "
            f"{np.mean(profondeurs):.0f} px (min {np.min(profondeurs):.0f}, max {np.max(profondeurs):.0f})"
        )
    print(f"\n{len(evenements)} bascule(s) :")
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
        f"{chemin.name} — fond vide + contours (Sobel) | phase vide {frames_vides} frames"
    )
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_contours.png")
    print("Graphique : trajectoire_contours.png")


if __name__ == "__main__":
    main()
