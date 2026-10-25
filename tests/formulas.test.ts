/**
 * Tests unitaires pour les formules de calcul RSI
 */

import { describe, it, expect } from 'vitest';
import {
  calculateRSI,
  calculateRSIFromTimestamps,
  formatRSIResult,
  calculateStats,
  validateFrames,
  validateVideoMetadata,
  secondsToMs,
  metersToCm,
  DEFAULT_GRAVITY
} from '../src/calculation/formulas';

describe('calculateRSI', () => {
  it('devrait calculer RSI avec des valeurs valides', () => {
    // Données test: atterrissage frame 100, décollage frame 120, atterrissage final frame 150
    // fps = 240
    // temps_contact = (120 - 100) / 240 = 20 / 240 = 0.0833s
    // temps_vol = (150 - 120) / 240 = 30 / 240 = 0.125s
    // hauteur = 9.81 * (0.125)^2 / 8 = 9.81 * 0.015625 / 8 = 0.01914m
    // RSI = 0.01914 / 0.0833 = 0.230m/s
    
    const result = calculateRSI(100, 120, 150, 240);
    
    expect(result.contactTime).toBeCloseTo(0.0833, 3);
    expect(result.flightTime).toBeCloseTo(0.125, 3);
    expect(result.height).toBeCloseTo(0.01914, 3);
    expect(result.rsi).toBeCloseTo(0.23, 1);
    expect(result.totalTime).toBeCloseTo(0.2083, 3);
  });

  it('devrait calculer RSI avec gravité personnalisée', () => {
    const gravity = 10; // Utiliser g = 10 pour simplifier
    const result = calculateRSI(100, 120, 150, 240, gravity);
    
    // hauteur = 10 * (0.125)^2 / 8 = 10 * 0.015625 / 8 = 0.01953125m
    // RSI = 0.01953125 / 0.0833 = 0.2344m/s
    
    expect(result.height).toBeCloseTo(0.01953, 3);
    expect(result.rsi).toBeCloseTo(0.2344, 3);
  });

  it('devrait calculer le RSI modifié', () => {
    const result = calculateRSI(100, 120, 150, 240);
    
    // RSI modifié = hauteur / temps_total
    // temps_total = 0.0833 + 0.125 = 0.2083
    // RSI modifié = 0.01914 / 0.2083 = 0.0919m/s
    
    expect(result.modifiedRsi).toBeCloseTo(0.0919, 3);
  });

  it('devrait lancer une erreur si les frames ne sont pas dans l\'ordre', () => {
    expect(() => calculateRSI(120, 100, 150, 240))
      .toThrow('Le frame d\'atterrissage doit être avant le frame de décollage');
  });

  it('devrait lancer une erreur si fps <= 0', () => {
    expect(() => calculateRSI(100, 120, 150, 0))
      .toThrow('FPS doit être supérieur à 0');
  });

  it('devrait lancer une erreur si gravity <= 0', () => {
    expect(() => calculateRSI(100, 120, 150, 240, 0))
      .toThrow('La gravité doit être supérieure à 0');
  });

  it('devrait calculer avec des frames très proches', () => {
    // Test avec des frames consécutifs
    const result = calculateRSI(100, 101, 102, 240);

    expect(result.contactTime).toBeCloseTo(1 / 240, 5);
    expect(result.flightTime).toBeCloseTo(1 / 240, 5);
    // hauteur = 9.81 * (1/240)² / 8 ≈ 2.127e-5 m
    expect(result.height).toBeCloseTo(9.81 / (240 * 240) / 8, 8);
  });

  it('devrait calculer avec un saut très haut (temps de vol long)', () => {
    // 60 frames de vol à 240fps = 0.25s
    const result = calculateRSI(100, 120, 180, 240);
    
    // hauteur = 9.81 * (0.25)^2 / 8 = 9.81 * 0.0625 / 8 = 0.0766m
    expect(result.height).toBeCloseTo(0.0766, 3);
  });
});

describe('calculateRSIFromTimestamps (méthode VFR-exact)', () => {
  it('devrait donner les mêmes résultats que le calcul par frames en cadence constante', () => {
    // Équivalent de calculateRSI(100, 120, 150, 240) à cadence constante :
    // t1 = 100/240, t2 = 120/240, t3 = 150/240
    const byFrames = calculateRSI(100, 120, 150, 240);
    const byTimestamps = calculateRSIFromTimestamps(100 / 240, 120 / 240, 150 / 240);

    expect(byTimestamps.contactTime).toBeCloseTo(byFrames.contactTime, 10);
    expect(byTimestamps.flightTime).toBeCloseTo(byFrames.flightTime, 10);
    expect(byTimestamps.height).toBeCloseTo(byFrames.height, 10);
    expect(byTimestamps.rsi).toBeCloseTo(byFrames.rsi, 10);
    expect(byTimestamps.modifiedRsi).toBeCloseTo(byFrames.modifiedRsi, 10);
  });

  it('devrait gérer une cadence variable (VFR) : intervalles irréguliers', () => {
    // Drop jump VFR : atterrissage à t=1.000, contact irrégulier,
    // décollage à t=1.083, vol à cadence différente, retour à t=1.208
    const result = calculateRSIFromTimestamps(1.000, 1.083, 1.208);

    expect(result.contactTime).toBeCloseTo(0.083, 6);
    expect(result.flightTime).toBeCloseTo(0.125, 6);
    expect(result.height).toBeCloseTo(9.81 * 0.125 ** 2 / 8, 10);
    expect(result.rsi).toBeCloseTo((9.81 * 0.125 ** 2 / 8) / 0.083, 6);
  });

  it('devrait rejeter des timestamps désordonnés', () => {
    expect(() => calculateRSIFromTimestamps(1, 1, 2)).toThrow('atterrissage doit être avant');
    expect(() => calculateRSIFromTimestamps(0, 2, 1)).toThrow('décollage doit être avant');
    expect(() => calculateRSIFromTimestamps(NaN, 1, 2)).toThrow('Timestamps invalides');
  });
});

describe('formatRSIResult', () => {
  it('devrait formater correctement les résultats', () => {
    const result = {
      contactTime: 0.0833,
      flightTime: 0.125,
      height: 0.01914,
      rsi: 0.23,
      modifiedRsi: 0.0919,
      totalTime: 0.2083,
    };
    
    const formatted = formatRSIResult(result);
    
    expect(formatted.contactTimeMs).toBe(83);
    expect(formatted.flightTimeMs).toBe(125);
    expect(formatted.heightCm).toBe(2);
    expect(formatted.rsi).toBe(0.23);
    expect(formatted.modifiedRsi).toBe(0.09);
  });

  it('devrait arrondir correctement les valeurs', () => {
    const result = {
      contactTime: 0.1,
      flightTime: 0.2,
      height: 0.123456,
      rsi: 1.234567,
      modifiedRsi: 0.987654,
      totalTime: 0.3,
    };
    
    const formatted = formatRSIResult(result);
    
    expect(formatted.contactTimeMs).toBe(100);
    expect(formatted.flightTimeMs).toBe(200);
    expect(formatted.heightCm).toBe(12);
    expect(formatted.rsi).toBe(1.23);
    expect(formatted.modifiedRsi).toBe(0.99);
  });
});

describe('calculateStats', () => {
  it('devrait calculer la moyenne et l\'écart-type', () => {
    const values = [1, 2, 3, 4, 5];
    const stats = calculateStats(values);
    
    expect(stats.mean).toBe(3);
    expect(stats.stdDev).toBeCloseTo(1.58, 2);
  });

  it('devrait retourner 0 pour un tableau vide', () => {
    const stats = calculateStats([]);
    
    expect(stats.mean).toBe(0);
    expect(stats.stdDev).toBe(0);
  });

  it('devrait retourner 0 pour écart-type avec un seul élément', () => {
    const stats = calculateStats([5]);
    
    expect(stats.mean).toBe(5);
    expect(stats.stdDev).toBe(0);
  });

  it('devrait calculer avec des valeurs négatives', () => {
    const values = [-2, -1, 0, 1, 2];
    const stats = calculateStats(values);
    
    expect(stats.mean).toBe(0);
    expect(stats.stdDev).toBeCloseTo(1.58, 2);
  });
});

describe('validateFrames', () => {
  it('devrait valider des frames dans l\'ordre correct', () => {
    expect(validateFrames(0, 10, 20)).toBe(true);
    expect(validateFrames(100, 120, 150)).toBe(true);
  });

  it('devrait invalider si landing >= takeoff', () => {
    expect(validateFrames(10, 10, 20)).toBe(false);
    expect(validateFrames(10, 5, 20)).toBe(false);
  });

  it('devrait invalider si takeoff >= finalLanding', () => {
    expect(validateFrames(10, 20, 20)).toBe(false);
    expect(validateFrames(10, 20, 15)).toBe(false);
  });

  it('devrait invalider si frames négatifs', () => {
    expect(validateFrames(-1, 10, 20)).toBe(false);
    expect(validateFrames(10, -1, 20)).toBe(false);
    expect(validateFrames(10, 20, -1)).toBe(false);
  });
});

describe('validateVideoMetadata', () => {
  it('devrait valider des métadonnées valides', () => {
    expect(validateVideoMetadata(240, 1000)).toBe(true);
    expect(validateVideoMetadata(120, 500)).toBe(true);
  });

  it('devrait invalider fps <= 0', () => {
    expect(validateVideoMetadata(0, 1000)).toBe(false);
    expect(validateVideoMetadata(-10, 1000)).toBe(false);
  });

  it('devrait invalider frameCount <= 0', () => {
    expect(validateVideoMetadata(240, 0)).toBe(false);
    expect(validateVideoMetadata(240, -10)).toBe(false);
  });
});

describe('Conversions d\'unités', () => {
  it('devrait convertir secondes en millisecondes', () => {
    expect(secondsToMs(1)).toBe(1000);
    expect(secondsToMs(0.5)).toBe(500);
    expect(secondsToMs(0.001)).toBe(1);
  });

  it('devrait convertir mètres en centimètres', () => {
    expect(metersToCm(1)).toBe(100);
    expect(metersToCm(0.5)).toBe(50);
    expect(metersToCm(0.01)).toBe(1);
  });
});

describe('DEFAULT_GRAVITY', () => {
  it('devrait avoir la valeur par défaut de 9.81', () => {
    expect(DEFAULT_GRAVITY).toBe(9.81);
  });
});

describe('Cas réels de calcul RSI', () => {
  it('devrait calculer RSI pour un drop jump typique', () => {
    // Scénario: Drop jump de 40cm
    // Temps de contact: 0.2s (48 frames à 240fps)
    // Temps de vol: 0.4s (96 frames à 240fps)
    // landing: frame 100, takeoff: frame 148, finalLanding: frame 244
    
    const result = calculateRSI(100, 148, 244, 240);
    
    // temps_contact = (148 - 100) / 240 = 48 / 240 = 0.2s
    // temps_vol = (244 - 148) / 240 = 96 / 240 = 0.4s
    // hauteur = 9.81 * (0.4)^2 / 8 = 9.81 * 0.16 / 8 = 0.1962m
    // RSI = 0.1962 / 0.2 = 0.981m/s
    
    expect(result.contactTime).toBeCloseTo(0.2, 3);
    expect(result.flightTime).toBeCloseTo(0.4, 3);
    expect(result.height).toBeCloseTo(0.1962, 3);
    expect(result.rsi).toBeCloseTo(0.981, 2);
  });

  it('devrait calculer RSI pour un saut très explosif', () => {
    // Temps de contact très court: 0.1s (24 frames à 240fps)
    // Temps de vol: 0.3s (72 frames à 240fps)
    // landing: frame 100, takeoff: frame 124, finalLanding: frame 196
    
    const result = calculateRSI(100, 124, 196, 240);
    
    // hauteur = 9.81 * (0.3)^2 / 8 = 9.81 * 0.09 / 8 = 0.1104m
    // RSI = 0.1104 / 0.1 = 1.104m/s
    
    expect(result.contactTime).toBeCloseTo(0.1, 3);
    expect(result.height).toBeCloseTo(0.1104, 3);
    expect(result.rsi).toBeCloseTo(1.104, 2);
  });

  it('devrait calculer RSI pour un saut moins explosif', () => {
    // Temps de contact plus long: 0.3s (72 frames à 240fps)
    // Temps de vol: 0.2s (48 frames à 240fps)
    // landing: frame 100, takeoff: frame 172, finalLanding: frame 220
    
    const result = calculateRSI(100, 172, 220, 240);
    
    // hauteur = 9.81 * (0.2)^2 / 8 = 9.81 * 0.04 / 8 = 0.04905m
    // RSI = 0.04905 / 0.3 = 0.1635m/s
    
    expect(result.contactTime).toBeCloseTo(0.3, 3);
    expect(result.height).toBeCloseTo(0.04905, 3);
    expect(result.rsi).toBeCloseTo(0.1635, 3);
  });
});
