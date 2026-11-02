"""
SUIVI DU PIED PAR DESCENTE DE JAMBE LOCALE (idée utilisateur, sans image
de fond pendant le suivi).

Problème résolu : la soustraction des contours du fond efface les contours
du pied là où ils se superposent à des arêtes déjà présentes dans la scène.
Ici, on ne soustrait RIEN : on suit les contours LOCALEMENT.

Principe :
1. INITIALISATION (une seule fois, frame FRAME_INIT) : position du pied
   par le masque fort du fond vide — position connue au départ.
2. À CHAQUE FRAME : fenêtre de recherche autour de la position précédente
   (Sobel dans la fenêtre seulement — calcul négligeable).
   On attrape les composantes de contours qui traversent la bande
   [position - 80, position - 40] : ce sont les bords de la JAMBE. Le
   contour de la jambe se prolonge naturellement autour du pied
   (tibia → cheville → chaussure) : le point le plus BAS de ces
   composantes est le bas du pied. Le pied qui s'allonge (pointes tendues
   au décollage) est suivi par construction.
3. RÉFÉRENCE en parallèle (même passe) : bas du masque fond-vide seuil 60
   — affiché en cyan dans la vidéo pour comparaison directe.

Sorties : verification_descente_jambe.mp4 (jaune = fenêtre, vert = suivi
+ composantes suivies, cyan = référence fond vide), analyse comparée
(croisements, vols) et trajectoire_descente.png.
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
from PIL import Image, ImageDraw
from scipy import ndimage
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
FRAME_INIT = 3800        # frame d'initialisation (athlète debout avant les sauts)
SEUIL_INIT = 60.0        # masque fort pour l'initialisation uniquement

SEUIL_SOBEL = 300.0      # magnitude de gradient = contour (validée)
DEMI_ROI_X = 90          # fenêtre de recherche : demi-largeur
ROI_AU_DESSUS = 110      # extension de la fenêtre au-dessus de la position
ROI_EN_DESSOUS = 70      # extension en dessous
BANDE_HAUT = 80          # bande d'accroche des bords de jambe : de -80…
BANDE_BAS = 40           # …à -40 par rapport à la position précédente
TOL_X = 40               # tolérance horizontale autour de la position
MIN_COMPOSANTE = 40      # composante plus petite ignorée

SEUIL_VIDE = 3.0
MAX_FRAMES_VIDES = 1500
POURCENT_SOL = 90.0
RAYON = 3

COULEUR_SUIVI = (60, 255, 60)    # vert : descente de jambe
COULEUR_REFERENCE = (60, 200, 255)  # cyan : fond vide seuil 60
COULEUR_CADRE = (255, 230, 40)   # jaune : fenêtre de recherche

# -------------------------------------------------------


def probe(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def magnitude_sobel(gris: np.ndarray) -> np.ndarray:
    f = gris.astype(np.float32)
    gx = ndimage.sobel(f, axis=1, mode="nearest")
    gy = ndimage.sobel(f, axis=0, mode="nearest")
    return np.sqrt(gx * gx + gy * gy)


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    fps = probe(exe, chemin)
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps")

    # ---------------- Fond vide (pour l'initialisation + référence) ----------------
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    assert proc.stdout is not None
    taille = l * h * 3
    grises = []
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
    print(f"Phase vide : {frames_vides} frames — fond prêt (init + référence uniquement)")

    # ---------------- Encodage ----------------
    largeur_out = (l * 3 // 2) + (l * 3 // 2) % 2
    hauteur_out = (h * 3 // 2) + (h * 3 // 2) % 2
    sortie = chemin.parent / "verification_descente_jambe.mp4"
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

    structure = ndimage.generate_binary_structure(2, 2)

    suivi: list[dict] = []      # descente de jambe
    reference: list[float] = []  # fond vide seuil 60
    pos_x = pos_y = 0.0
    en_piste = False

    n = 0
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.int16)

        # ---- Référence : bas du masque fort (fond vide, seuil 60) ----
        masque_fort = np.abs(gris - fond) > SEUIL_INIT
        if int(masque_fort.sum()) >= 50:
            lignes = np.nonzero(masque_fort.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * 0.02))
            reference.append(float(np.median(lignes[-nb_bas:])))
        else:
            reference.append(reference[-1] if reference else float(h))

        # ---- Descente de jambe ----
        if n == FRAME_INIT:
            lignes = np.nonzero(masque_fort.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * 0.02))
            bas = lignes[-nb_bas:]
            pos_y = float(np.median(bas))
            cols = np.nonzero(masque_fort[bas[len(bas) // 2]] | masque_fort[bas[-1]])[0]
            pos_x = float(cols.mean()) if len(cols) > 0 else l / 2
            en_piste = True
            print(f"Initialisation frame {FRAME_INIT + 1} : pied à ({pos_x:.0f}, {pos_y:.0f})")
            suivi.append({"frame": n, "x": pos_x, "y": pos_y, "fiable": 1, "taille": 0})
            composante_affichee = None

        elif en_piste:
            # Fenêtre de recherche autour de la position précédente
            ry0 = max(0, int(pos_y) - ROI_AU_DESSUS)
            rx0 = max(0, int(pos_x) - DEMI_ROI_X)
            ry1 = min(h, int(pos_y) + ROI_EN_DESSOUS + 1)
            rx1 = min(l, int(pos_x) + DEMI_ROI_X + 1)
            roi = gris[ry0:ry1, rx0:rx1]

            aretes = magnitude_sobel(roi) > SEUIL_SOBEL
            etiquettes, nb = ndimage.label(aretes, structure=structure)
            composante_affichee = None
            if nb > 0:
                # Bande d'accroche : [pos_y - BANDE_HAUT, pos_y - BANDE_BAS]
                by0 = max(0, int(pos_y) - BANDE_HAUT - ry0)
                by1 = max(0, int(pos_y) - BANDE_BAS - ry0)
                bx = int(pos_x) - rx0
                bande = etiquettes[by0:by1, max(0, bx - TOL_X): bx + TOL_X + 1]
                ids = np.unique(bande[bande > 0])
                masque_grab = np.isin(etiquettes, ids)
                tailles_ok = [
                    i for i in ids
                    if int((etiquettes == i).sum()) >= MIN_COMPOSANTE
                ]
                if len(tailles_ok) > 0:
                    union = np.isin(etiquettes, tailles_ok)
                    ys_union = np.nonzero(union.any(axis=1))[0]
                    nouveau_y = float(ys_union.max() + ry0)
                    # x : centroïde des lignes du bas de l'union
                    bas_rows = union[ys_union.max() - min(9, len(ys_union) - 1): ys_union.max() + 1]
                    xs_union = np.nonzero(bas_rows.any(axis=0))[0]
                    if len(xs_union) > 0:
                        pos_x = float(xs_union.mean() + rx0)
                    # anti-dérive : le pied ne peut pas fuir de plus de
                    # ROI_EN_DESSOUS par frame — borne de toute façon par la ROI
                    pos_y = nouveau_y
                    composante_affichee = (rx0, ry0, union)
                    suivi.append({"frame": n, "x": pos_x, "y": pos_y, "fiable": 1,
                                  "taille": int(union.sum())})
                else:
                    suivi.append({"frame": n, "x": pos_x, "y": pos_y, "fiable": 0, "taille": 0})
            else:
                suivi.append({"frame": n, "x": pos_x, "y": pos_y, "fiable": 0, "taille": 0})

        # ---- Rendu ----
        rgb16 = rgb.astype(np.int16)
        if en_piste and suivi:
            dernier = suivi[-1]
            px, py = int(dernier["x"]), int(dernier["y"])
            # composantes suivies : vert translucide
            if composante_affichee is not None:
                cx0, cy0, union = composante_affichee
                zone = rgb16[cy0: cy0 + union.shape[0], cx0: cx0 + union.shape[1]]
                verte = np.zeros_like(zone)
                verte[:, :] = COULEUR_SUIVI
                zone[union] = (0.55 * verte[union] + 0.45 * zone[union]).astype(np.int16)
                rgb16[cy0: cy0 + union.shape[0], cx0: cx0 + union.shape[1]] = zone
            # cadre de la fenêtre
            image = Image.fromarray(rgb16.astype(np.uint8))
            dessin = ImageDraw.Draw(image)
            dessin.rectangle(
                [max(0, px - DEMI_ROI_X), max(0, py - ROI_AU_DESSUS),
                 min(l - 1, px + DEMI_ROI_X), min(h - 1, py + ROI_EN_DESSOUS)],
                outline=COULEUR_CADRE, width=1,
            )
            rgb8 = np.array(image)
            # marqueur du pied (vert) + référence fond vide (cyan)
            if 0 <= py < h:
                rgb8[max(0, py - RAYON): py + RAYON + 1, max(0, px - 30): px + 31, :] = COULEUR_SUIVI
                rgb8[max(0, py - 6): py + 7, max(0, px - 8): px + 9, :] = COULEUR_SUIVI
            yr = int(reference[-1])
            if 0 <= yr < h:
                rgb8[max(0, yr - 1): yr + 2, : l // 5, :] = COULEUR_REFERENCE
        else:
            rgb8 = rgb16.astype(np.uint8)

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
    print(f"\n{n} frames | suivi depuis {FRAME_INIT + 1} ({len(suivi)} frames)")
    fiables_nb = sum(1 for s in suivi if s["fiable"])
    print(f"Suivi fiable : {fiables_nb}/{len(suivi)}")
    print(f"Vidéo résultat : {sortie}")
    print("Rappel : vert = composantes suivies + bas du pied ; jaune = fenêtre ;")
    print("  cyan (quart gauche) = référence fond vide seuil 60")

    # ---------------- Analyse comparée ----------------
    with open(chemin.parent / "descente_jambe.json", "w", encoding="utf-8") as f:
        json.dump(suivi, f, ensure_ascii=False)
    print("Données : descente_jambe.json")

    if not suivi:
        return
    y_suivi = np.array([s["y"] for s in suivi])
    fiab = np.array([s["fiable"] for s in suivi], dtype=float)
    lisse_suivi = d.mediane_glissante(y_suivi, d.FENETRE_LISSAGE)

    y_ref = np.array(reference)[FRAME_INIT:]
    lisse_ref = d.mediane_glissante(y_ref, d.FENETRE_LISSAGE)

    # Ligne de sol + bascules pour chaque trajectoire
    def analyser(lissee: np.ndarray, fiableite: np.ndarray):
        fiables_px = lissee[fiableite > 0]
        sol = float(np.percentile(fiables_px, POURCENT_SOL))
        amplitude = float(fiables_px.max() - fiables_px.min())
        deltas = np.abs(np.diff(lissee))
        en_vol = lissee[1:] < sol - 0.1 * amplitude
        bruit = float(np.median(deltas[en_vol])) if en_vol.sum() >= 8 else 1.0
        epsilon = max(2 * bruit, 0.02 * amplitude, 1.0)
        seuil = sol - epsilon
        seuils = lissee >= seuil
        evenements = []
        precedent = seuils[0]
        for i in range(1, len(seuils)):
            if seuils[i] != precedent:
                evenements.append(
                    ("descente" if seuils[i] else "montée", i)
                )
                precedent = seuils[i]
        fusionnes = []
        for ev in evenements:
            if fusionnes and ev[1] - fusionnes[-1][1] < d.SEGMENT_MIN_FRAMES:
                fusionnes[-1] = ev
            else:
                fusionnes.append(ev)
        return sol, seuil, fusionnes

    sol_s, seuil_s, ev_s = analyser(lisse_suivi, fiab)
    fiab_ref = np.ones_like(fiab)
    sol_r, seuil_r, ev_r = analyser(lisse_ref, fiab_ref)

    ecart = np.abs(lisse_suivi - lisse_ref)
    print(f"\nDescente de jambe : sol {sol_s:.0f} px | {len(ev_s)} bascules")
    print(f"Référence fond vide : sol {sol_r:.0f} px | {len(ev_r)} bascules")
    en_vol_ref = lisse_ref < sol_r - 0.5 * max(1.0, sol_r - seuil_r)
    print(f"Écart moyen avec la référence : {ecart.mean():.1f} px (max {ecart.max():.0f})")
    if en_vol_ref.any():
        print(f"  pendant les vols (référence) : {ecart[en_vol_ref].mean():.1f} px")
        print(f"  pendant les contacts : {ecart[~en_vol_ref].mean():.1f} px")

    print("\nBascules (descente de jambe vs référence) :")
    for direction, i in ev_s:
        plus_proche = min((r for _, r in ev_r), key=lambda r: abs(r - i), default=None)
        ecart_f = f"{plus_proche - i:+d}" if plus_proche is not None else "—"
        print(
            f"  frame {suivi[0]['frame'] + i + 1:>6} | {direction:9s} | "
            f"référence à {ecart_f} frames"
        )

    # Graphique
    frames = [s["frame"] for s in suivi]
    fig, ax = plt.subplots(figsize=(14, 5), dpi=120)
    ax.plot(frames, y_suivi, color="#9aa1b5", alpha=0.3, linewidth=0.8, label="descente brute")
    ax.plot(frames, lisse_suivi, color="#4d9fff", linewidth=1.6, label="descente lissée")
    ax.plot(frames, lisse_ref, color="#ff9a3c", linewidth=1.3, alpha=0.9, label="référence fond vide (seuil 60)")
    ax.axhline(sol_s, color="#e6a23c", linewidth=1.1, label="ligne de sol (descente)")
    for direction, i in ev_s:
        ax.axvline(suivi[0]["frame"] + i, color="#2ecc71", linewidth=1.0, alpha=0.7)
    ax.invert_yaxis()
    ax.set_xlabel("frame")
    ax.set_ylabel("position du bas du pied (px)")
    ax.set_title(f"{chemin.name} — descente de jambe locale depuis la frame {FRAME_INIT + 1}")
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_descente.png")
    print("Graphique : trajectoire_descente.png")


if __name__ == "__main__":
    main()
