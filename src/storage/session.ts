/**
 * Module de gestion des sessions
 * Contient la logique métier pour la création et gestion des sessions
 */

import type { Session, Trial, MarkerPoints, VideoMetadata } from '../types';
import { calculateRSI, formatRSIResult } from '../calculation';

/**
 * Génère un ID unique
 * @returns ID unique
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Crée une nouvelle session
 * @param name - Nom de la session
 * @param dropHeightCm - Hauteur de drop en centimètres
 * @returns Nouvelle session
 */
export function createSession(name: string, dropHeightCm: number): Session {
  const today = new Date().toISOString().split('T')[0];
  
  return {
    id: generateId(),
    name,
    dropHeightCm,
    date: today,
    trials: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Crée un nouvel essai à partir des marqueurs
 * @param sessionId - ID de la session
 * @param markers - Points de marquage
 * @param metadata - Métadonnées vidéo
 * @param gravity - Gravité (optionnelle)
 * @returns Nouvel essai
 */
export function createTrialFromMarkers(
  sessionId: string,
  markers: MarkerPoints,
  metadata: VideoMetadata,
  gravity: number = 9.81
): Trial {
  // Récupérer les frames
  const landingFrame = markers.landing?.frameNumber || 0;
  const takeoffFrame = markers.takeoff?.frameNumber || 0;
  const finalLandingFrame = markers.finalLanding?.frameNumber || 0;
  
  // Calculer le RSI
  const result = calculateRSI(
    landingFrame,
    takeoffFrame,
    finalLandingFrame,
    metadata.fps,
    gravity
  );
  
  const formattedResult = formatRSIResult(result);
  
  return {
    id: generateId(),
    sessionId,
    timestamp: Date.now(),
    markers: {
      landing: markers.landing,
      takeoff: markers.takeoff,
      finalLanding: markers.finalLanding,
    },
    metadata: {
      ...metadata,
      // Sauvegarder seulement les métadonnées nécessaires
      fps: metadata.fps,
      frameCount: metadata.frameCount,
    },
    result,
    formattedResult,
    notes: '',
  };
}

/**
 * Met à jour une session
 * @param session - Session à mettre à jour
 * @param updates - Mises à jour
 * @returns Session mise à jour
 */
export function updateSession(session: Session, updates: Partial<Session>): Session {
  return {
    ...session,
    ...updates,
    updatedAt: Date.now(),
  };
}

/**
 * Ajoute un essai à une session
 * @param session - Session
 * @param trial - Essai à ajouter
 * @returns Session mise à jour
 */
export function addTrialToSession(session: Session, trial: Trial): Session {
  return {
    ...session,
    trials: [...session.trials, trial],
    updatedAt: Date.now(),
  };
}

/**
 * Supprime un essai d'une session
 * @param session - Session
 * @param trialId - ID de l'essai à supprimer
 * @returns Session mise à jour
 */
export function removeTrialFromSession(session: Session, trialId: string): Session {
  return {
    ...session,
    trials: session.trials.filter(t => t.id !== trialId),
    updatedAt: Date.now(),
  };
}

/**
 * Valide une session
 * @param session - Session à valider
 * @returns Vrai si la session est valide
 */
export function validateSession(session: Partial<Session>): boolean {
  return Boolean(
    session.name &&
    typeof session.name === 'string' &&
    session.name.trim().length > 0 &&
    session.dropHeightCm !== undefined &&
    typeof session.dropHeightCm === 'number' &&
    session.dropHeightCm > 0
  );
}

/**
 * Valide un essai
 * @param trial - Essai à valider
 * @returns Vrai si l'essai est valide
 */
export function validateTrial(trial: Partial<Trial>): boolean {
  return (
    trial.result !== undefined &&
    trial.formattedResult !== undefined &&
    trial.metadata !== undefined &&
    trial.metadata.fps > 0
  );
}

/**
 * Obtient les statistiques d'une session
 * @param session - Session
 * @returns Statistiques de la session
 */
export function getSessionStats(session: Session) {
  const rsiValues = session.trials.map(t => t.formattedResult.rsi);
  const modifiedRsiValues = session.trials.map(t => t.formattedResult.modifiedRsi);
  const heightValues = session.trials.map(t => t.formattedResult.heightCm);
  const contactTimeValues = session.trials.map(t => t.formattedResult.contactTimeMs);
  const flightTimeValues = session.trials.map(t => t.formattedResult.flightTimeMs);

  // Calculer les moyennes
  const meanRsi = rsiValues.length > 0 
    ? rsiValues.reduce((sum, r) => sum + r, 0) / rsiValues.length
    : 0;
  
  const meanModifiedRsi = modifiedRsiValues.length > 0
    ? modifiedRsiValues.reduce((sum, r) => sum + r, 0) / modifiedRsiValues.length
    : 0;
  
  const meanHeight = heightValues.length > 0
    ? heightValues.reduce((sum, h) => sum + h, 0) / heightValues.length
    : 0;
  
  const meanContactTime = contactTimeValues.length > 0
    ? contactTimeValues.reduce((sum, t) => sum + t, 0) / contactTimeValues.length
    : 0;
  
  const meanFlightTime = flightTimeValues.length > 0
    ? flightTimeValues.reduce((sum, t) => sum + t, 0) / flightTimeValues.length
    : 0;

  // Calculer les écarts-types
  const calculateStdDev = (values: number[]): number => {
    if (values.length <= 1) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
  };

  return {
    sessionId: session.id,
    meanRsi: parseFloat(meanRsi.toFixed(2)),
    stdDevRsi: parseFloat(calculateStdDev(rsiValues).toFixed(2)),
    meanModifiedRsi: parseFloat(meanModifiedRsi.toFixed(2)),
    stdDevModifiedRsi: parseFloat(calculateStdDev(modifiedRsiValues).toFixed(2)),
    meanHeight: parseFloat(meanHeight.toFixed(2)),
    meanContactTime: parseFloat(meanContactTime.toFixed(2)),
    meanFlightTime: parseFloat(meanFlightTime.toFixed(2)),
    trialCount: session.trials.length,
  };
}

/**
 * Trie les sessions par date (plus récentes en premier)
 * @param sessions - Sessions à trier
 * @returns Sessions triées
 */
export function sortSessionsByDate(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Filtre les sessions par nom
 * @param sessions - Sessions à filtrer
 * @param query - Terme de recherche
 * @returns Sessions filtrées
 */
export function filterSessionsByName(sessions: Session[], query: string): Session[] {
  const lowerQuery = query.toLowerCase();
  return sessions.filter(session => 
    session.name.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Obtient les sessions pour une date spécifique
 * @param sessions - Sessions à filtrer
 * @param date - Date au format YYYY-MM-DD
 * @returns Sessions pour cette date
 */
export function getSessionsByDate(sessions: Session[], date: string): Session[] {
  return sessions.filter(session => session.date === date);
}
