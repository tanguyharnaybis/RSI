/**
 * Détermination de la source des temps réels.
 *
 * Le temps VIDÉO entre deux frames est toujours exact (timestamps ffmpeg).
 * La conversion en temps réel dépend de la structure du fichier :
 *
 *  - Conteneur à cadence de capture (≥ 100 fps, ex. fichier iPhone
 *    original à 240 fps) : le fichier joue l'action à sa vitesse réelle.
 *    Temps réel = Δtimestamps / duplication détectée. Le FPS saisi
 *    N'EST PAS utilisé.
 *
 *  - Conteneur lent (< 100 fps, ex. export slow-mo ré-échantillonné à
 *    30 fps) : la vidéo est étirée, et la cadence de capture est absente
 *    du fichier — indistinguable d'une vidéo normale à cette cadence.
 *    Le FPS d'enregistrement saisi est alors requis pour le facteur
 *    (étirement = fps saisi / fps conteneur). La source est signalée.
 *
 * Dans tous les cas, l'interface affiche quelle donnée est utilisée.
 */

export type TimeSource = 'timestamps' | 'manual-fps';

export interface TimeFactor {
  /** Facteur de conversion temps vidéo → temps réel (≥ 1) */
  factor: number;
  /** Source utilisée pour la conversion */
  source: TimeSource;
  /** Description lisible (affichée dans l'interface) */
  label: string;
}

/**
 * Cadence minimale considérée comme une cadence de capture plausible.
 * Les caméras capturent à 120/240 fps ; un conteneur plus lent est un
 * export ré-échantillonné (ou une vidéo native lente — indistinguable).
 */
const MIN_CAPTURE_FPS = 100;

/**
 * Détermine le facteur temps réel et sa source.
 * @param containerFps - Cadence du conteneur (1 / intervalle médian, 0 si inconnue)
 * @param duplicationConfirmed - Facteur de duplication confirmé (≥ 1)
 * @param manualFps - FPS d'enregistrement saisi
 */
export function determineTimeFactor(
  containerFps: number,
  duplicationConfirmed: number,
  manualFps: number
): TimeFactor {
  const duplication = Math.max(1, duplicationConfirmed);

  // Sans information de conteneur : repli sur le FPS saisi
  if (!(containerFps > 0)) {
    return {
      factor: duplication,
      source: 'manual-fps',
      label: `FPS d'enregistrement saisi (${manualFps})`,
    };
  }

  // Conteneur à cadence de capture : timestamps seuls suffisent
  if (containerFps >= MIN_CAPTURE_FPS) {
    if (duplication > 1) {
      return {
        factor: duplication,
        source: 'timestamps',
        label: `timestamps exacts — duplication ×${duplication} détectée automatiquement (FPS saisi ignoré)`,
      };
    }
    return {
      factor: 1,
      source: 'timestamps',
      label: 'timestamps exacts — cadence de capture (FPS saisi ignoré)',
    };
  }

  // Conteneur lent : vidéo étirée ou cadence native lente — la cadence de
  // capture n'est pas dans le fichier : le FPS d'enregistrement saisi
  // est requis pour le facteur d'étirement.
  const stretch = Math.max(1, Math.round(manualFps / containerFps));
  const factor = stretch * duplication;
  return {
    factor,
    source: 'manual-fps',
    label:
      `FPS d'enregistrement saisi (${manualFps}) — facteur ×${factor}` +
      (duplication > 1 ? ` (dont duplication ×${duplication})` : '') +
      ' : cadence de capture absente du fichier',
  };
}

// ---------------------------------------------------------------------------
// Estimation de duplication depuis les scores de mouvement
// ---------------------------------------------------------------------------

/**
 * Seuil d'Otsu : sépare les scores en deux classes (calme / mouvement)
 * en maximisant la variance inter-classes.
 */
export function otsuThreshold(sorted: Float64Array): number {
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
 * Estime le facteur de duplication (frames identiques consécutives)
 * depuis les scores de mouvement. Dans un fichier où chaque frame est
 * dupliquée ×N, seules les frames uniques montrent du mouvement : les
 * frames actives (score élevé) apparaissent tous les N samples. La
 * médiane des écarts entre frames actives donne N.
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
