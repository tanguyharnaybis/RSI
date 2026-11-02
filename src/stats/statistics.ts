/**
 * Module de calcul des statistiques avancées
 */

import type { Session, SessionStats } from '../types';

/**
 * Calcule les statistiques pour une session
 * @param session - Session à analyser
 * @returns Statistiques de la session
 */
export function calculateSessionStats(session: Session): SessionStats {
  const rsiValues = session.trials.map(t => t.formattedResult.rsi);
  const heightValues = session.trials.map(t => t.formattedResult.heightCm);
  const contactTimeValues = session.trials.map(t => t.formattedResult.contactTimeMs);
  const flightTimeValues = session.trials.map(t => t.formattedResult.flightTimeMs);

  const stats: SessionStats = {
    sessionId: session.id,
    meanRsi: 0,
    stdDevRsi: 0,
    meanHeight: 0,
    meanContactTime: 0,
    meanFlightTime: 0,
    trialCount: session.trials.length,
  };

  if (rsiValues.length > 0) {
    stats.meanRsi = parseFloat((rsiValues.reduce((sum, r) => sum + r, 0) / rsiValues.length).toFixed(2));
    stats.stdDevRsi = parseFloat(calculateStdDev(rsiValues).toFixed(2));
  }

  if (heightValues.length > 0) {
    stats.meanHeight = parseFloat((heightValues.reduce((sum, h) => sum + h, 0) / heightValues.length).toFixed(2));
  }

  if (contactTimeValues.length > 0) {
    stats.meanContactTime = parseFloat((contactTimeValues.reduce((sum, t) => sum + t, 0) / contactTimeValues.length).toFixed(2));
  }

  if (flightTimeValues.length > 0) {
    stats.meanFlightTime = parseFloat((flightTimeValues.reduce((sum, t) => sum + t, 0) / flightTimeValues.length).toFixed(2));
  }

  return stats;
}

/**
 * Calcule l'écart-type
 * @param values - Tableau de valeurs
 * @returns Écart-type
 */
function calculateStdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Calcule les statistiques globales sur plusieurs sessions
 * @param sessions - Sessions à analyser
 * @returns Statistiques globales
 */
export function calculateGlobalStats(sessions: Session[]) {
  const allRsi: number[] = [];
  const allHeights: number[] = [];
  const sessionStats: SessionStats[] = [];

  sessions.forEach(session => {
    const stats = calculateSessionStats(session);
    sessionStats.push(stats);
    
    allRsi.push(...session.trials.map(t => t.formattedResult.rsi));
    allHeights.push(...session.trials.map(t => t.formattedResult.heightCm));
  });

  const totalTrials = sessions.reduce((sum, s) => sum + s.trials.length, 0);

  return {
    totalSessions: sessions.length,
    totalTrials,
    averageRsi: allRsi.length > 0 ? parseFloat((allRsi.reduce((sum, r) => sum + r, 0) / allRsi.length).toFixed(2)) : 0,
    averageHeight: allHeights.length > 0 ? parseFloat((allHeights.reduce((sum, h) => sum + h, 0) / allHeights.length).toFixed(2)) : 0,
    bestSession: sessionStats.length > 0 ? sessionStats.reduce((best, current) => 
      current.meanRsi > best.meanRsi ? current : best
    ) : null,
    sessionStats,
  };
}

/**
 * Obtient les données pour le graphique de progression
 * @param sessions - Sessions à analyser
 * @returns Données pour le graphique
 */
export function getProgressChartData(sessions: Session[]) {
  // Trier les sessions par date
  const sortedSessions = [...sessions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const labels: string[] = [];
  const rsiData: number[] = [];
  const heightData: number[] = [];
  const contactTimeData: number[] = [];
  const flightTimeData: number[] = [];

  sortedSessions.forEach(session => {
    const stats = calculateSessionStats(session);
    
    labels.push(session.date);
    rsiData.push(stats.meanRsi);
    heightData.push(stats.meanHeight);
    contactTimeData.push(stats.meanContactTime);
    flightTimeData.push(stats.meanFlightTime);
  });

  return {
    labels,
    datasets: {
      rsi: rsiData,
      height: heightData,
      contactTime: contactTimeData,
      flightTime: flightTimeData,
    },
  };
}

/**
 * Calcule la tendance (amélioration ou dégradation) sur les sessions
 * @param sessions - Sessions à analyser
 * @returns Tendance (positive, négative ou nulle)
 */
export function calculateTrend(sessions: Session[]): {
  trend: 'improving' | 'declining' | 'stable';
  change: number;
  percentage: number;
} {
  if (sessions.length < 2) {
    return { trend: 'stable', change: 0, percentage: 0 };
  }

  // Trier par date
  const sortedSessions = [...sessions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const firstSession = sortedSessions[0];
  const lastSession = sortedSessions[sortedSessions.length - 1];

  const firstValue = calculateSessionStats(firstSession).meanRsi;
  const lastValue = calculateSessionStats(lastSession).meanRsi;

  const change = lastValue - firstValue;
  const percentage = firstValue !== 0 ? (change / firstValue) * 100 : 0;

  if (change > 0.1) {
    return { trend: 'improving', change, percentage };
  } else if (change < -0.1) {
    return { trend: 'declining', change, percentage };
  } else {
    return { trend: 'stable', change, percentage };
  }
}

/**
 * Obtient les statistiques par essai dans une session
 * @param session - Session à analyser
 * @returns Statistiques par essai
 */
export function getTrialStats(session: Session) {
  return session.trials.map(trial => ({
    trialId: trial.id,
    trialNumber: session.trials.indexOf(trial) + 1,
    rsi: trial.formattedResult.rsi,
    height: trial.formattedResult.heightCm,
    contactTime: trial.formattedResult.contactTimeMs,
    flightTime: trial.formattedResult.flightTimeMs,
    totalTime: trial.result.totalTime,
  }));
}

/**
 * Calcule le coefficient de variation
 * @param values - Tableau de valeurs
 * @returns Coefficient de variation en pourcentage
 */
export function calculateCoefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  
  if (mean === 0) return 0;
  
  const stdDev = calculateStdDev(values);
  return (stdDev / mean) * 100;
}

/**
 * Calcule les percentiles
 * @param values - Tableau de valeurs
 * @param percentiles - Percentiles à calculer (ex: [25, 50, 75])
 * @returns Objet avec les percentiles
 */
export function calculatePercentiles(values: number[], percentiles: number[] = [25, 50, 75]): Record<number, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const result: Record<number, number> = {};

  percentiles.forEach(percentile => {
    const index = Math.floor((percentile / 100) * sorted.length);
    result[percentile] = sorted[index] || 0;
  });

  return result;
}
