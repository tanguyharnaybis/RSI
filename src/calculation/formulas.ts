/**
 * Module de calcul du Reactive Strength Index (RSI)
 * 
 * Formules :
 * - temps de contact = (frame2 - frame1) / fps
 * - temps de vol = (frame3 - frame2) / fps
 * - hauteur de saut = g * t_vol² / 8
 * - RSI = hauteur / temps_de_contact
 * - RSI modifié = hauteur / temps_total
 */

import type { RSIResult, FormattedRSIResult } from '../types';

// Constante gravitationnelle par défaut (m/s²)
const DEFAULT_GRAVITY = 9.81;

/**
 * Calcule le Reactive Strength Index à partir des frames marquées
 * @param landingFrame - Frame d'atterrissage (premier contact)
 * @param takeoffFrame - Frame de décollage (dernier contact)
 * @param finalLandingFrame - Frame d'atterrissage final
 * @param fps - Frames par seconde de la vidéo
 * @param gravity - Accélération gravitationnelle (m/s²), par défaut 9.81
 * @returns Résultats du calcul RSI
 */
export function calculateRSI(
  landingFrame: number,
  takeoffFrame: number,
  finalLandingFrame: number,
  fps: number,
  gravity: number = DEFAULT_GRAVITY
): RSIResult {
  // Validation des entrées
  if (fps <= 0) {
    throw new Error('FPS doit être supérieur à 0');
  }
  
  if (gravity <= 0) {
    throw new Error('La gravité doit être supérieure à 0');
  }

  if (landingFrame >= takeoffFrame) {
    throw new Error('Le frame d\'atterrissage doit être avant le frame de décollage');
  }

  if (takeoffFrame >= finalLandingFrame) {
    throw new Error('Le frame de décollage doit être avant le frame d\'atterrissage final');
  }

  // Calcul des temps en secondes
  const contactTime = (takeoffFrame - landingFrame) / fps;
  const flightTime = (finalLandingFrame - takeoffFrame) / fps;
  const totalTime = contactTime + flightTime;

  // Calcul de la hauteur de saut (en mètres)
  // Formule: h = g * t_vol² / 8
  // Derivée de: h = 1/2 * g * (t_vol / 2)² * 2 (temps de montée + descente)
  const height = gravity * Math.pow(flightTime, 2) / 8;

  // Calcul du RSI (hauteur / temps de contact)
  const rsi = contactTime > 0 ? height / contactTime : 0;

  // Calcul du RSI modifié (hauteur / temps total)
  const modifiedRsi = totalTime > 0 ? height / totalTime : 0;

  return {
    contactTime,
    flightTime,
    height,
    rsi,
    modifiedRsi,
    totalTime,
  };
}

/**
 * Calcule le RSI à partir des timestamps RÉELS des frames marquées
 * (méthode VFR-exact : le temps entre deux frames est une différence de
 * timestamps, correcte même quand la cadence varie au fil de la vidéo).
 * @param landingTime - Temps réel de l'atterrissage (s)
 * @param takeoffTime - Temps réel du décollage (s)
 * @param finalLandingTime - Temps réel de l'atterrissage final (s)
 * @param gravity - Accélération gravitationnelle (m/s²)
 * @returns Résultats du calcul RSI
 */
export function calculateRSIFromTimestamps(
  landingTime: number,
  takeoffTime: number,
  finalLandingTime: number,
  gravity: number = DEFAULT_GRAVITY
): RSIResult {
  if (!Number.isFinite(landingTime) || !Number.isFinite(takeoffTime) || !Number.isFinite(finalLandingTime)) {
    throw new Error('Timestamps invalides');
  }
  if (gravity <= 0) {
    throw new Error('La gravité doit être supérieure à 0');
  }
  if (landingTime >= takeoffTime) {
    throw new Error('Le frame d\'atterrissage doit être avant le frame de décollage');
  }
  if (takeoffTime >= finalLandingTime) {
    throw new Error('Le frame de décollage doit être avant le frame d\'atterrissage final');
  }

  const contactTime = takeoffTime - landingTime;
  const flightTime = finalLandingTime - takeoffTime;
  const totalTime = contactTime + flightTime;

  const height = gravity * Math.pow(flightTime, 2) / 8;
  const rsi = contactTime > 0 ? height / contactTime : 0;
  const modifiedRsi = totalTime > 0 ? height / totalTime : 0;

  return { contactTime, flightTime, height, rsi, modifiedRsi, totalTime };
}

/**
 * Formate les résultats RSI pour affichage
 * @param result - Résultats RSI à formater
 * @returns Résultats formatés pour l'interface utilisateur
 */
export function formatRSIResult(result: RSIResult): FormattedRSIResult {
  return {
    contactTimeMs: Math.round(result.contactTime * 1000),
    flightTimeMs: Math.round(result.flightTime * 1000),
    heightCm: Math.round(result.height * 100),
    rsi: parseFloat(result.rsi.toFixed(2)),
    modifiedRsi: parseFloat(result.modifiedRsi.toFixed(2)),
  };
}

/**
 * Calcule la moyenne et l'écart-type d'une série de valeurs
 * @param values - Tableau de valeurs numériques
 * @returns Objet avec moyenne et écart-type
 */
export function calculateStats(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) {
    return { mean: 0, stdDev: 0 };
  }

  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  
  if (values.length === 1) {
    return { mean, stdDev: 0 };
  }

  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);

  return {
    mean: parseFloat(mean.toFixed(2)),
    stdDev: parseFloat(stdDev.toFixed(2)),
  };
}

/**
 * Valide que les frames sont dans l'ordre correct
 * @param markers - Points de marquage
 * @returns Vrai si les frames sont valides
 */
export function validateFrames(
  landingFrame: number,
  takeoffFrame: number,
  finalLandingFrame: number
): boolean {
  return (
    landingFrame >= 0 &&
    takeoffFrame > landingFrame &&
    finalLandingFrame > takeoffFrame
  );
}

/**
 * Vérifie si les métadonnées vidéo sont valides pour le calcul
 * @param fps - Frames par seconde
 * @param frameCount - Nombre total de frames
 * @returns Vrai si valide
 */
export function validateVideoMetadata(fps: number, frameCount: number): boolean {
  return fps > 0 && frameCount > 0;
}

/**
 * Convertit les secondes en millisecondes
 * @param seconds - Temps en secondes
 * @returns Temps en millisecondes
 */
export function secondsToMs(seconds: number): number {
  return seconds * 1000;
}

/**
 * Convertit les mètres en centimètres
 * @param meters - Longueur en mètres
 * @returns Longueur en centimètres
 */
export function metersToCm(meters: number): number {
  return meters * 100;
}

// Exporter les constantes
 export { DEFAULT_GRAVITY };
