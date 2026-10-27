/**
 * Détection des événements de pogo jump depuis la trajectoire de la
 * pointe du pied (landmarks MediaPipe Pose) — modules purs, testés.
 *
 * Repère IMAGE : y augmente vers le BAS. Le sol est donc aux y grands ;
 * la pointe "descend" quand y augmente, "monte" quand y diminue.
 *
 * Pipeline :
 *  1. Lissage de la trajectoire (moyenne mobile courte)
 *  2. Estimation de la ligne de sol (moyenne glissante des positions y
 *     minimales stables = phases d'appui)
 *  3. Epsilon adaptatif (amplitude du bruit mesurée pendant les vols)
 *  4. Détection des croisements du seuil : PREMIER CONTACT (descente
 *     de la pointe au niveau du sol, vitesse s'annule) et DERNIER
 *     CONTACT (montée franche au-dessus du seuil = décollage)
 *  5. Sous-frame : régression linéaire sur 3-4 points autour du
 *     croisement → instant du croisement à la milliseconde
 *  6. Reconstruction cyclique : une seule timeline d'événements
 *     alternés ; l'atterrissage final d'un saut est le premier contact
 *     du suivant (jamais dupliqué)
 */

// ---------------------------------------------------------------------------
// Lissage
// ---------------------------------------------------------------------------

/** Moyenne mobile centrée (fenêtre impaire) */
export function smooth(values: Float64Array, window: number): Float64Array {
  const half = Math.max(1, Math.floor(window / 2));
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let k = i - half; k <= i + half; k++) {
      if (k >= 0 && k < values.length) {
        sum += values[k];
        count++;
      }
    }
    out[i] = sum / count;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ligne de sol
// ---------------------------------------------------------------------------

/**
 * Estime la ligne de sol : moyenne glissante des positions y minimales
 * stables (phases d'appui). Le cadrage étant fixe en protocole, le sol
 * est quasi constant ; une fenêtre glissante tolère un léger mouvement.
 * @param y Trajectoire lissée de la pointe
 * @param times Temps vidéo de chaque frame (s)
 * @param windowSec Fenêtre glissante (s, défaut 2)
 * @returns Ligne de sol par frame
 */
export function estimateGroundLine(
  y: Float64Array,
  times: Float64Array,
  windowSec = 2
): Float64Array {
  const ground = new Float64Array(y.length);
  // Les phases d'appui sont les y les plus grands (pointe au sol) :
  // pour chaque fenêtre, moyenne des y du quartile bas de l'image.
  const windowFrames = Math.max(
    10,
    Math.round(windowSec / Math.max(1e-3, medianInterval(times)))
  );

  for (let i = 0; i < y.length; i++) {
    const start = Math.max(0, i - windowFrames);
    const end = Math.min(y.length, i + windowFrames);
    const slice = Array.from(y.slice(start, end));
    // Moyenne des 15 % les plus bas (y grand = au sol)
    slice.sort((a, b) => b - a);
    const lowCount = Math.max(1, Math.round(slice.length * 0.15));
    let sum = 0;
    for (let k = 0; k < lowCount; k++) sum += slice[k];
    ground[i] = sum / lowCount;
  }
  return ground;
}

/** Intervalle médian entre frames (s) */
export function medianInterval(times: Float64Array): number {
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 1 / 240;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

// ---------------------------------------------------------------------------
// Epsilon adaptatif
// ---------------------------------------------------------------------------

/**
 * Epsilon adaptatif : amplitude de bruit mesurée sur la dérivée première
 * de la trajectoire pendant les vols (au-dessus du sol), ×2, avec un
 * plancher relatif à l'amplitude du mouvement.
 */
export function adaptiveEpsilon(y: Float64Array, ground: Float64Array): number {
  // Frames en vol : au-dessus du sol (y nettement plus petit)
  const deltas: number[] = [];
  for (let i = 1; i < y.length; i++) {
    const inFlight = y[i] < ground[i] - 0.05 && y[i - 1] < ground[i - 1] - 0.05;
    if (inFlight) deltas.push(Math.abs(y[i] - y[i - 1]));
  }
  let noise: number;
  if (deltas.length >= 8) {
    deltas.sort((a, b) => a - b);
    noise = deltas[Math.floor(deltas.length / 2)]; // médiane : robuste
  } else {
    noise = 0.002;
  }
  // Amplitude du mouvement (pour le plancher)
  let minY = Infinity;
  let maxY = -Infinity;
  for (const value of y) {
    if (value < minY) minY = value;
    if (value > maxY) maxY = value;
  }
  const amplitude = maxY - minY;
  return Math.max(noise * 2, amplitude * 0.01, 0.002);
}

// ---------------------------------------------------------------------------
// Sous-frame : interpolation du croisement
// ---------------------------------------------------------------------------

/**
 * Régression linéaire des y autour du croisement du seuil → instant du
 * croisement interpolé (précision sous-frame).
 * @returns Temps interpolé (s), ou null si la régression échoue
 */
export function interpolateCrossingTime(
  times: Float64Array,
  y: Float64Array,
  frameIndex: number,
  threshold: number
): number | null {
  // Points autour de la frame de croisement (3-4 points)
  const span = Math.min(2, Math.max(1, Math.floor(y.length / 8)));
  const indices: number[] = [];
  for (let k = frameIndex - span; k <= frameIndex + span; k++) {
    if (k >= 0 && k < times.length) indices.push(k);
  }
  if (indices.length < 2) return null;

  // Régression linéaire y = a·t + b
  let n = 0;
  let sumT = 0;
  let sumY = 0;
  let sumTT = 0;
  let sumTY = 0;
  for (const i of indices) {
    const t = times[i];
    const v = y[i];
    n++;
    sumT += t;
    sumY += v;
    sumTT += t * t;
    sumTY += t * v;
  }
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-12) return null;
  const a = (n * sumTY - sumT * sumY) / denom;
  if (Math.abs(a) < 1e-9) return null;
  const b = (sumY - a * sumT) / n;

  const crossing = (threshold - b) / a;
  // L'interpolé doit rester dans la fenêtre des points utilisés
  const tMin = times[indices[0]];
  const tMax = times[indices[indices.length - 1]];
  if (crossing < tMin || crossing > tMax) return null;
  return crossing;
}

// ---------------------------------------------------------------------------
// Détection des événements
// ---------------------------------------------------------------------------

export type FootEventType = 'first-contact' | 'last-contact';

export interface FootEvent {
  type: FootEventType;
  /** Frame la plus proche du croisement (base d'édition manuelle) */
  frame: number;
  /** Temps interpolé du croisement (s), null si interpolation impossible */
  time: number | null;
  /** Visibilité des landmarks du pied à cet instant */
  visibility: number;
}

export interface EventDetectionOptions {
  /** Seuil de vitesse verticale « franche » (unités y/frame) */
  velocityThreshold?: number;
  /** Visibilités des landmarks par frame (pour la traçabilité) */
  visibility?: Float64Array;
  /**
   * Exiger que la descente s'arrête pour valider un premier contact
   * (true par défaut). Passer à false dans le labo de détection : en pogo
   * la pointe rebondit sans s'arrêter, et ce critère peut faire rater
   * un atterrissage — ce qui saute alors un contact entier.
   */
  requireSettling?: boolean;
}

/**
 * Détecte les événements PREMIER/DERNIER CONTACT le long de la
 * trajectoire lissée. Machine à états vol/contact sur le seuil
 * y_sol − epsilon, avec instants interpolés au croisement.
 */
export function detectFootEvents(
  times: Float64Array,
  smoothY: Float64Array,
  ground: Float64Array,
  epsilon: number,
  options: EventDetectionOptions = {}
): FootEvent[] {
  const events: FootEvent[] = [];
  const velocityThreshold = options.velocityThreshold ?? 0.0005;
  const requireSettling = options.requireSettling ?? true;
  const visibility = options.visibility;

  if (smoothY.length < 4) return events;

  let inContact = false;
  for (let i = 1; i < smoothY.length; i++) {
    const threshold = ground[i] - epsilon;
    const atGround = smoothY[i] >= threshold;
    const prevAtGround = smoothY[i - 1] >= ground[i - 1] - epsilon;

    if (!inContact && atGround && !prevAtGround) {
      // Croisement descendant : PREMIER CONTACT
      // La descente doit s'arrêter (vitesse s'annule/inverse) : vérifiée
      // sur la frame suivante si disponible — désactivable (labo)
      const settling =
        i + 1 >= smoothY.length ||
        smoothY[i + 1] - smoothY[i] <= Math.abs(smoothY[i] - smoothY[i - 1]);
      if (!requireSettling || settling) {
        const time = interpolateCrossingTime(times, smoothY, i, threshold);
        events.push({
          type: 'first-contact',
          frame: i,
          time,
          visibility: visibility ? visibility[i] : 1,
        });
        inContact = true;
      }
    } else if (inContact && !atGround && prevAtGround) {
      // Croisement montant : DERNIER CONTACT (décollage) — la montée
      // doit être franche (vitesse verticale négative nette)
      const velocity = smoothY[i] - smoothY[i - 1];
      if (velocity < -velocityThreshold) {
        const time = interpolateCrossingTime(times, smoothY, i, threshold);
        events.push({
          type: 'last-contact',
          frame: i,
          time,
          visibility: visibility ? visibility[i] : 1,
        });
        inContact = false;
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Reconstruction cyclique des sauts
// ---------------------------------------------------------------------------

export interface PogoJump {
  /** Premier contact (frame proposée, éditable) */
  landingFrame: number;
  /** Temps réel du premier contact (interpolé ou frame) */
  landingTime: number;
  /** Dernier contact / décollage */
  takeoffFrame: number;
  takeoffTime: number;
  /** Premier contact suivant : atterrissage final = début du contact suivant */
  finalLandingFrame: number;
  finalLandingTime: number;
  /**
   * Avertissement si le cycle sort des bornes du protocole (null = conforme).
   * Un cycle hors bornes reste PROPOSÉ : le supprimer automatiquement
   * casserait le partage des contacts entre sauts successifs et décalerait
   * toute la suite — la décision appartient à l'utilisateur.
   */
  warning: string | null;
}

export interface RejectedJump {
  /** Frames des événements concernés (diagnostic) */
  from: number;
  to: number;
  reason: string;
}

export interface ReconstructOptions {
  minContactMs?: number;
  maxContactMs?: number;
  minFlightMs?: number;
  maxFlightMs?: number;
}

/**
 * Reconstruit les sauts depuis la timeline d'événements alternés.
 * Logique cyclique : l'atterrissage final d'un saut EST le premier
 * contact du suivant — une seule timeline, aucun doublon.
 *
 * Règles :
 *  - le vol initial (avant le premier contact) est ignoré ;
 *  - le contact final non suivi d'un vol complet est ignoré ;
 *  - les cycles HORS BORNES (contact < 80 ms ou > 400 ms, vol < 100 ms
 *    ou > 600 ms) restent PROPOSÉS avec un avertissement : rejeter
 *    automatiquement casserait le partage des contacts (le saut suivant
 *    commencerait au contact d'après) et décalerait toute la suite.
 *    C'est l'utilisateur qui valide ou rejette ;
 *  - sont réellement rejetés : événements désordonnés/chevauchants
 *    (temps négatif) et temps indisponibles.
 *
 * @param events Événements triés par temps (frames)
 * @param frameTimes Temps réel de chaque frame (s)
 */
export function reconstructJumps(
  events: FootEvent[],
  frameTimes: Float64Array,
  options: ReconstructOptions = {}
): { jumps: PogoJump[]; rejected: RejectedJump[] } {
  const minContactMs = options.minContactMs ?? 80;
  const maxContactMs = options.maxContactMs ?? 400;
  const minFlightMs = options.minFlightMs ?? 100;
  const maxFlightMs = options.maxFlightMs ?? 600;

  const jumps: PogoJump[] = [];
  const rejected: RejectedJump[] = [];

  const timeOf = (event: FootEvent): number | null => {
    if (event.time !== null && Number.isFinite(event.time)) return event.time;
    if (event.frame >= 0 && event.frame < frameTimes.length) return frameTimes[event.frame];
    return null;
  };

  // Attendre le premier « first-contact » : le vol initial est ignoré.
  let start = 0;
  while (start < events.length && events[start].type !== 'first-contact') {
    start++;
  }

  let i = start;
  while (i < events.length) {
    const first = events[i];
    if (first.type !== 'first-contact') {
      // Chevauchement : deux « last-contact » consécutifs → incohérence
      rejected.push({
        from: first.frame,
        to: first.frame,
        reason: 'Événements désordonnés (chevauchement) — pied ou cadrage bougé ?',
      });
      i++;
      continue;
    }

    const last = events[i + 1];
    if (!last || last.type !== 'last-contact') {
      // Contact final non suivi d'un décollage : contact incomplet → fin
      break;
    }

    const nextFirst = events[i + 2];
    if (!nextFirst || nextFirst.type !== 'first-contact') {
      // Dernier contact non suivi d'un nouvel atterrissage : vol final
      // incomplet → le contact final est ignoré (règle du brief)
      break;
    }

    const t1 = timeOf(first);
    const t2 = timeOf(last);
    const t3 = timeOf(nextFirst);

    if (t1 === null || t2 === null || t3 === null) {
      rejected.push({ from: first.frame, to: nextFirst.frame, reason: 'Temps indisponible' });
      i += 2;
      continue;
    }

    const contactMs = (t2 - t1) * 1000;
    const flightMs = (t3 - t2) * 1000;

    if (contactMs < 0 || flightMs < 0) {
      rejected.push({
        from: first.frame,
        to: nextFirst.frame,
        reason: 'Événements chevauchants (temps négatif)',
      });
      i += 2;
      continue;
    }

    const reasons: string[] = [];
    if (contactMs < minContactMs) reasons.push(`contact ${contactMs.toFixed(0)} ms < ${minContactMs} ms`);
    if (contactMs > maxContactMs) reasons.push(`contact ${contactMs.toFixed(0)} ms > ${maxContactMs} ms`);
    if (flightMs < minFlightMs) reasons.push(`vol ${flightMs.toFixed(0)} ms < ${minFlightMs} ms`);
    if (flightMs > maxFlightMs) reasons.push(`vol ${flightMs.toFixed(0)} ms > ${maxFlightMs} ms`);

    // Cycle hors bornes : PROPOSÉ avec avertissement (jamais supprimé
    // automatiquement) pour préserver le partage des contacts.
    jumps.push({
      landingFrame: first.frame,
      landingTime: t1,
      takeoffFrame: last.frame,
      takeoffTime: t2,
      finalLandingFrame: nextFirst.frame,
      finalLandingTime: t3,
      warning: reasons.length > 0 ? reasons.join(', ') : null,
    });
    // CYCLIQUE : le « first-contact » suivant ouvre déjà le saut suivant
    i += 2;
  }

  return { jumps, rejected };
}
