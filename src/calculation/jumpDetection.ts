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
  /**
   * Facteur de duplication (frames identiques consécutives, estimé depuis
   * les scores). > 1 : les scores sont réduits à 1 par groupe de N
   * copies avant la segmentation — sans quoi les scores nuls des copies
   * fausserient la calibration du seuil.
   */
  duplication?: number;
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
 * Estime le facteur de duplication (frames identiques consécutives) depuis
 * les scores de mouvement — AVANT toute navigation manuelle.
 *
 * Dans un fichier où chaque frame est dupliquée ×N, seules les frames
 * uniques montrent du mouvement : les frames « actives » (score élevé)
 * apparaissent tous les N samples. La médiane des écarts entre frames
 * actives donne N. Sur un fichier sans duplication, les frames actives
 * sont consécutives → N = 1.
 */
export function estimateDuplication(sceneScores: Float64Array): number {
  if (sceneScores.length < 16) return 1;

  const sorted = Float64Array.from(sceneScores).sort();
  const threshold = otsuThreshold(sorted);

  const activeIndices: number[] = [];
  for (let i = 0; i < sceneScores.length; i++) {
    if (sceneScores[i] > threshold) activeIndices.push(i);
  }
  if (activeIndices.length < 4) return 1;

  const gaps: number[] = [];
  for (let i = 1; i < activeIndices.length; i++) {
    const gap = activeIndices[i] - activeIndices[i - 1];
    if (gap >= 1) gaps.push(gap);
  }
  if (gaps.length === 0) return 1;

  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  return Math.min(32, Math.max(1, medianGap));
}

/**
 * Détecte les sauts d'une série à partir des scores de mouvement.
 */
export function detectJumps(params: DetectionParams): DetectionResult {
  const minContactMs = params.minContactMs ?? 60;
  const maxContactMs = params.maxContactMs ?? 500;
  const duplication = Math.max(1, Math.round(params.duplication ?? 1));
  const empty: DetectionResult = {
    jumps: [],
    activeThreshold: 0,
    calmThreshold: 0,
    confidence: 'faible',
  };

  if (
    params.sceneScores.length < 10 ||
    params.frameTimes.length !== params.sceneScores.length
  ) {
    return empty;
  }

  // Réduction des copies : 1 score par groupe de N (le vrai mouvement est
  // le maximum du groupe, les copies portent des scores nuls). Les temps
  // réels suivent (1 sur N) — les durées restent exactes.
  let sceneScores = params.sceneScores;
  let frameTimes = params.frameTimes;
  if (duplication > 1) {
    const groupCount = Math.floor(params.sceneScores.length / duplication);
    if (groupCount < 10) return empty;
    const scores = new Float64Array(groupCount);
    const times = new Float64Array(groupCount);
    for (let g = 0; g < groupCount; g++) {
      let max = 0;
      for (let k = 0; k < duplication; k++) {
        const score = params.sceneScores[g * duplication + k];
        if (score > max) max = score;
      }
      scores[g] = max;
      times[g] = params.frameTimes[g * duplication];
    }
    sceneScores = scores;
    frameTimes = times;
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
