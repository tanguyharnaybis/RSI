/**
 * Tests unitaires de la détection automatique des sauts
 * (profils de mouvement synthétiques — aucune vidéo requise)
 */

import { describe, it, expect } from 'vitest';
import { detectJumps } from '../src/calculation/jumpDetection';

/**
 * Profil réaliste d'une série de pogo jumps : immobilité initiale, puis
 * pour chaque saut un contact bref suivi d'un vol actif (avec apex),
 * puis la réception finale absorbée par l'immobilité de fin de vidéo.
 */
function buildProfile(jumps: number, opts: { contactFrames?: number; flightFrames?: number; idleFrames?: number } = {}) {
  const contactFrames = opts.contactFrames ?? 36; // 150 ms à 240 fps
  const flightFrames = opts.flightFrames ?? 108; // 450 ms à 240 fps
  const idleFrames = opts.idleFrames ?? 120;

  const scores: number[] = [];
  const times: number[] = [];
  let frame = 0;

  const push = (count: number, score: number) => {
    for (let i = 0; i < count; i++) {
      scores.push(score);
      times.push(frame / 240);
      frame++;
    }
  };

  // Immobilité initiale (sujet debout) — ignorée par le détecteur
  push(idleFrames, 0.01);
  // Impulsion initiale : flexion-extension active (mouvement, non mesurable)
  push(60, 0.12);

  // Série : vol actif (avec apex bref) puis appui calme, pour chaque contact
  for (let j = 0; j < jumps; j++) {
    push(flightFrames / 2 - 3, 0.15);
    push(6, 0.03); // apex ≈ 25 ms : PAS un appui
    push(flightFrames / 2 - 3, 0.15);
    push(contactFrames, 0.02);
  }

  // Immobilité finale (absorbe le dernier appui)
  push(idleFrames, 0.01);

  return { sceneScores: Float64Array.from(scores), frameTimes: Float64Array.from(times) };
}

describe('detectJumps', () => {
  it('détecte tous les sauts d\'une série de 10 pogo jumps', () => {
    const { sceneScores, frameTimes } = buildProfile(11); // 11 contacts → 10 sauts mesurables
    const result = detectJumps({ sceneScores, frameTimes, expectedJumps: 10 });

    expect(result.jumps).toHaveLength(10);
    expect(result.confidence).toBe('haute');
    // Durées de contact plausibles (~150 ms)
    for (const jump of result.jumps) {
      expect(jump.contactDurationMs).toBeGreaterThan(100);
      expect(jump.contactDurationMs).toBeLessThan(200);
    }
  });

  it('structure correcte : atterrissage < décollage < atterrissage final', () => {
    const { sceneScores, frameTimes } = buildProfile(4);
    const result = detectJumps({ sceneScores, frameTimes });

    expect(result.jumps).toHaveLength(3);
    for (const jump of result.jumps) {
      expect(jump.landingFrame).toBeLessThan(jump.takeoffFrame);
      expect(jump.takeoffFrame).toBeLessThan(jump.finalLandingFrame);
      // L'atterrissage proposé est la frame juste AVANT le calme (impact)
      expect(jump.landingFrame).toBeGreaterThanOrEqual(0);
    }
  });

  it('ignore les apexs (creux brefs au milieu des vols)', () => {
    const { sceneScores, frameTimes } = buildProfile(3);
    const result = detectJumps({ sceneScores, frameTimes, expectedJumps: 2 });

    expect(result.jumps).toHaveLength(2);
    expect(result.confidence).toBe('haute');
  });

  it('ignore les immobilités longues (début/fin de vidéo)', () => {
    const { sceneScores, frameTimes } = buildProfile(3, { idleFrames: 600 }); // 2,5 s
    const result = detectJumps({ sceneScores, frameTimes });

    expect(result.jumps).toHaveLength(2);
  });

  it('enchaîne correctement : le décollage du saut n précède l\'atterrissage final', () => {
    const { sceneScores, frameTimes } = buildProfile(3);
    const result = detectJumps({ sceneScores, frameTimes });

    // Le vol entre les deux contacts appartient au saut 1
    expect(result.jumps[0].finalLandingFrame).toBeGreaterThan(result.jumps[0].takeoffFrame);
    expect(result.jumps[1].landingFrame).toBe(result.jumps[0].finalLandingFrame);
  });

  it('confiance moyenne quand le compte diffère d\'un saut de l\'attendu', () => {
    const { sceneScores, frameTimes } = buildProfile(10);
    const result = detectJumps({ sceneScores, frameTimes, expectedJumps: 10 });
    expect(result.confidence).toBe('moyenne');
  });

  it('confiance faible quand la détection est très éloignée de l\'attendu', () => {
    const { sceneScores, frameTimes } = buildProfile(3);
    const result = detectJumps({ sceneScores, frameTimes, expectedJumps: 10 });
    expect(result.confidence).toBe('faible');
  });

  it('retourne vide sur des données trop courtes ou incohérentes', () => {
    const short = detectJumps({
      sceneScores: Float64Array.from([0.1, 0.2, 0.1]),
      frameTimes: Float64Array.from([0, 1, 2].map((t) => t / 240)),
    });
    expect(short.jumps).toHaveLength(0);
    expect(short.confidence).toBe('faible');

    const mismatch = detectJumps({
      sceneScores: Float64Array.from(new Array(50).fill(0.1)),
      frameTimes: Float64Array.from(new Array(40).fill(0).map((_, i) => i / 240)),
    });
    expect(mismatch.jumps).toHaveLength(0);
  });
});
