/**
 * Détection de frames dupliquées.
 *
 * Certains exports slow-mo (typiquement Android) étirent la vidéo en
 * dupliquant chaque sample N fois : le conteneur compte alors N fois
 * plus de samples que de frames réelles, et la navigation sample par
 * sample montre N fois la même image.
 *
 * Un sample dupliqué est un sample identique au précédent (l'encodeur
 * écrit la même image) ; deux frames réelles consécutives d'un slow-mo
 * 240 fps diffèrent toujours légèrement (mouvement du sujet).
 */

/**
 * Seuil de différence relative entre deux empreintes de frames.
 * En dessous : frames considérées identiques (dupliquées).
 * 0,04 % de variation moyenne par pixel distingue les samples
 * bit-identiques (≈ 0, même après ré-encodage) des vraies frames
 * d'un slow-mo 240 fps en mouvement.
 */
export const FRAME_DIFF_THRESHOLD = 0.0004;

/**
 * Calcule la différence relative entre deux empreintes en niveaux de gris
 * @param a - Première empreinte
 * @param b - Deuxième empreinte
 * @returns Différence relative entre 0 (identiques) et 1
 */
export function diffRatio(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / (255 * a.length);
}

/**
 * Estime le facteur de duplication à partir des distances observées
 * (nombre de samples sautés pour trouver une nouvelle frame).
 * Utilise le mode (valeur la plus fréquente) : les vraies frames sont
 * séparées par un nombre constant de samples.
 * @param distances - Distances observées
 * @returns Facteur de duplication estimé (≥ 1)
 */
export function computeDuplicationHint(distances: number[]): number {
  if (distances.length === 0) return 1;
  const counts = new Map<number, number>();
  for (const d of distances) {
    if (d >= 1) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = 1;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return Math.max(1, best);
}

/**
 * Facteur de duplication CONFIRMÉ, à utiliser pour les calculs.
 * Un facteur > 1 n'est retenu que s'il est clairement dominant
 * (≥ 3 observations et ≥ 60 % des distances observées) : ainsi une
 * vidéo sans duplication n'est jamais pénalisée par une observation
 * isolée, et une vraie duplication uniforme est détectée en quelques
 * navigations.
 * @param distances - Distances observées entre frames uniques
 * @returns Facteur confirmé (≥ 1)
 */
export function computeConfirmedDuplicationFactor(distances: number[]): number {
  if (distances.length === 0) return 1;
  const hint = computeDuplicationHint(distances);
  if (hint <= 1) return 1;
  const occurrences = distances.filter((d) => d === hint).length;
  if (occurrences >= 3 && occurrences / distances.length >= 0.6) {
    return hint;
  }
  return 1;
}
