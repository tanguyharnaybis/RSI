/**
 * Détection automatique des sauts (contacts au sol) dans une série.
 *
 * Principe : chaque frame porte un score de mouvement D(n) (différence
 * avec la frame précédente, collectée par ffmpeg pendant l'analyse).
 * Pour un pogo jump :
 *  - vol : D élevé prolongé,
 *  - contact au sol : plateau de D faible encadré par deux vols,
 *    durée réelle typique 60-500 ms,
 *  - apex (sommet du vol) : creux bref (< ~40 ms), ignoré.
 *
 * Les seuils sont calibrés sur la distribution de la vidéo (percentiles),
 * et les durées sur les temps réels issus des timestamps exacts.
 *
 * Le résultat est une PROPOSITION : l'utilisateur valide et ajuste chaque
 * saut manuellement (±1 frame) avant le calcul final.
 */

export interface JumpCandidate {
  /** Frame proposée pour l'atterrissage (premier contact) */
  landingFrame: number;
  /** Frame proposée pour le décollage (dernier contact) */
  takeoffFrame: number;
  /** Frame proposée pour l'atterrissage final */
  finalLandingFrame: number;
  /** Durée réelle estimée du contact (ms) */
  contactDurationMs: number;
}

export interface DetectionResult {
  /** Sauts complets détectés (contact i → contact i+1) */
  jumps: JumpCandidate[];
  /** Seuil calibré « mouvement » (informatif) */
  activeThreshold: number;
  /** Seuil calibré « calme » (informatif) */
  calmThreshold: number;
  /** Confiance de la détection */
  confidence: 'haute' | 'moyenne' | 'faible';
}

export interface DetectionParams {
  /** Score de mouvement par frame (0..1), même longueur que frameTimes */
  sceneScores: Float64Array;
  /** Temps RÉEL de chaque frame (secondes) */
  frameTimes: Float64Array;
  /** Nombre de sauts attendus (protocole) — pour la confiance */
  expectedJumps?: number | null;
  /** Durée minimale d'un contact (ms, défaut 60 — exclut les apexs) */
  minContactMs?: number;
  /** Durée maximale d'un contact (ms, défaut 500 — exclut les immobilités) */
  maxContactMs?: number;
}

interface CalmSegment {
  start: number;
  end: number;
  durationMs: number;
}

/** Percentile p (0..1) d'un tableau trié */
function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[index];
}

/**
 * Seuil d'Otsu : sépare les scores en deux classes (calme / mouvement)
 * en maximisant la variance inter-classes. Robuste aux immobilités longues
 * (début/fin de vidéo) qui pollueraient un seuil par percentiles.
 */
function otsuThreshold(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const min = sorted[0];
  const max = sorted[n - 1];
  if (max <= min) return min;

  const bins = 256;
  const histogram = new Array<number>(bins).fill(0);
  for (const value of sorted) {
    const bin = Math.min(bins - 1, Math.floor(((value - min) / (max - min)) * bins));
    histogram[bin]++;
  }

  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * histogram[i];

  let sumB = 0;
  let weightB = 0;
  let bestBin = 0;
  let bestVariance = -1;
  for (let i = 0; i < bins; i++) {
    weightB += histogram[i];
    if (weightB === 0) continue;
    const weightF = n - weightB;
    if (weightF === 0) break;
    sumB += i * histogram[i];
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      bestBin = i;
    }
  }
  return min + ((bestBin + 0.5) / bins) * (max - min);
}

/**
 * Détecte les sauts d'une série à partir des scores de mouvement.
 */
export function detectJumps(params: DetectionParams): DetectionResult {
  const { sceneScores, frameTimes } = params;
  const minContactMs = params.minContactMs ?? 60;
  const maxContactMs = params.maxContactMs ?? 500;
  const empty: DetectionResult = {
    jumps: [],
    activeThreshold: 0,
    calmThreshold: 0,
    confidence: 'faible',
  };

  if (
    sceneScores.length < 10 ||
    frameTimes.length !== sceneScores.length
  ) {
    return empty;
  }

  // Calibration sur la distribution de CETTE vidéo (aucune constante magique)
  const sorted = Float64Array.from(sceneScores).sort();
  const calmThreshold = otsuThreshold(sorted);
  const activeThreshold = percentile(sorted, 0.65);

  // Première frame en mouvement : tout ce qui précède (immobilité du
  // début de vidéo) n'est pas une série de contacts.
  let firstActive = -1;
  for (let i = 0; i < sceneScores.length; i++) {
    if (sceneScores[i] > calmThreshold) {
      firstActive = i;
      break;
    }
  }
  if (firstActive < 0) return { ...empty, calmThreshold, activeThreshold };

  // Segments calmes : runs de frames sous le seuil, après le premier mouvement
  const segments: CalmSegment[] = [];
  let start = -1;
  for (let i = firstActive; i <= sceneScores.length; i++) {
    const calm = i < sceneScores.length && sceneScores[i] <= calmThreshold;
    if (calm && start < 0) {
      start = i;
    } else if (!calm && start >= 0) {
      segments.push({
        start,
        end: i - 1,
        durationMs: (frameTimes[i - 1] - frameTimes[start]) * 1000,
      });
      start = -1;
    }
  }

  // Fusion des segments séparés par une brève éruption de mouvement (bruit)
  const merged: CalmSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start - previous.end <= 3) {
      previous.end = segment.end;
      previous.durationMs = (frameTimes[previous.end] - frameTimes[previous.start]) * 1000;
    } else {
      merged.push({ ...segment });
    }
  }

  // Appuis = segments de durée ≥ minContact. Les plus courts sont des
  // apexs (creux brefs au milieu des vols) : exclus.
  const supports = merged.filter((segment) => segment.durationMs >= minContactMs);

  // Saut complet : appui k (atterrissage→décollage, si durée ≤ maxContact)
  // suivi de l'appui k+1 (atterrissage final — seul son DÉBUT importe,
  // même s'il est absorbé par l'immobilité de fin de vidéo).
  // L'atterrissage proposé est la frame juste avant le calme : la frame
  // d'impact est la dernière en mouvement.
  const jumps: JumpCandidate[] = [];
  for (let k = 0; k < supports.length; k++) {
    const contact = supports[k];
    if (contact.durationMs > maxContactMs) continue; // pas de décollage fiable
    if (k + 1 >= supports.length) break; // pas d'atterrissage final
    const next = supports[k + 1];
    jumps.push({
      landingFrame: Math.max(0, contact.start - 1),
      takeoffFrame: contact.end,
      finalLandingFrame: Math.max(0, next.start - 1),
      contactDurationMs: contact.durationMs,
    });
  }

  // Confiance : comparaison au protocole attendu
  let confidence: DetectionResult['confidence'];
  if (params.expectedJumps != null) {
    const gap = Math.abs(jumps.length - params.expectedJumps);
    confidence = gap === 0 ? 'haute' : gap <= 1 ? 'moyenne' : 'faible';
  } else {
    confidence = jumps.length > 0 ? 'moyenne' : 'faible';
  }

  return { jumps, activeThreshold, calmThreshold, confidence };
}
