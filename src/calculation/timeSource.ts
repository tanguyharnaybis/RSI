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
