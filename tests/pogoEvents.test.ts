/**
 * Tests du pipeline de détection pogo (modules purs, aucune vidéo requise)
 * Cas demandés : reconstruction cyclique sans doublons (y compris
 * atterrissage partagé), premier vol ignoré, contact final incomplet,
 * cycles incohérents rejetés, interpolation sous-frame.
 */

import { describe, it, expect } from 'vitest';
import {
  smooth,
  estimateGroundLine,
  adaptiveEpsilon,
  interpolateCrossingTime,
  detectFootEvents,
  reconstructJumps,
} from '../src/pose/pogoEvents';
import type { FootEvent, FootEventType } from '../src/pose/pogoEvents';

const FPS = 240;
/** Temps vidéo par frame (s) */
const frameTime = (i: number) => i / FPS;

// ---------------------------------------------------------------------------
// Outils : trajectoire synthétique de pogo jump
// ---------------------------------------------------------------------------

/**
 * Construit une trajectoire de pointe : immobilité, vol (montée/descente
 * parabolique), contact au sol (y stable = sol), répétés.
 * Repère image : y augmente vers le bas ; le sol est à y = 0.9.
 */
function buildTrajectory(contacts: number, opts: { contactFrames?: number; flightFrames?: number } = {}) {
  const contactFrames = opts.contactFrames ?? 30; // 125 ms
  const flightFrames = opts.flightFrames ?? 84; // 350 ms
  const GROUND = 0.9;
  const APEX = 0.35;

  const y: number[] = [];
  // Immobilité initiale (sujet au sol)
  for (let k = 0; k < 30; k++) y.push(GROUND);

  for (let c = 0; c < contacts; c++) {
    // Contact : pointe au sol (léger écrasement)
    for (let k = 0; k < contactFrames; k++) y.push(GROUND + 0.01 * Math.sin(k));
    // Vol : parabole (montée puis descente) — y décroît (monte) jusqu'à l'apex
    for (let k = 0; k < flightFrames; k++) {
      const ratio = k / (flightFrames - 1); // 0 → 1
      const parabola = 4 * ratio * (1 - ratio); // 0 → 1 → 0
      y.push(GROUND - (GROUND - APEX) * parabola);
    }
  }
  // Dernier contact + immobilité finale
  for (let k = 0; k < contactFrames; k++) y.push(GROUND + 0.01 * Math.sin(k));
  for (let k = 0; k < 30; k++) y.push(GROUND);

  const times = Float64Array.from(y.map((_, i) => frameTime(i)));
  return { y: Float64Array.from(y), times, GROUND, flightFrames, contactFrames };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('smooth', () => {
  it('réduit le bruit en préservant la tendance', () => {
    const values = Float64Array.from([0, 0.1, 0, 0.1, 0, 0.1, 0]);
    const smoothed = smooth(values, 3);
    // Les oscillations sont atténuées
    const oscillation = (arr: Float64Array) =>
      arr.reduce((max, v, i) => (i > 0 ? Math.max(max, Math.abs(v - arr[i - 1])) : 0), 0);
    expect(oscillation(smoothed)).toBeLessThanOrEqual(oscillation(values));
  });
});

describe('estimateGroundLine', () => {
  it('estime le sol au niveau des appuis', () => {
    const { y, times, GROUND } = buildTrajectory(3);
    const ground = estimateGroundLine(y, times);
    // La ligne de sol doit être proche du vrai sol
    const mean = ground.reduce((s, v) => s + v, 0) / ground.length;
    expect(Math.abs(mean - GROUND)).toBeLessThan(0.05);
  });
});

describe('adaptiveEpsilon', () => {
  it('retourne un epsilon positif et petit devant l\'amplitude', () => {
    const { y, times } = buildTrajectory(3);
    const ground = estimateGroundLine(y, times);
    const epsilon = adaptiveEpsilon(y, ground);
    expect(epsilon).toBeGreaterThan(0);
    expect(epsilon).toBeLessThan(0.1);
  });
});

describe('interpolateCrossingTime (sous-frame)', () => {
  it('interpole le croisement à la sous-frame près', () => {
    // Trajectoire linéaire : y = 0.5 - 2·t (croise 0.4 à t = 0.05)
    const times = new Float64Array(10);
    const y = new Float64Array(10);
    for (let i = 0; i < 10; i++) {
      times[i] = i / 100; // 10 ms par frame
      y[i] = 0.5 - 2 * times[i];
    }
    const crossing = interpolateCrossingTime(times, y, 5, 0.4);
    expect(crossing).not.toBeNull();
    expect(crossing!).toBeCloseTo(0.05, 6);
  });

  it('retourne null quand la régression est dégénérée', () => {
    const times = Float64Array.from([0, 0.01, 0.02, 0.03]);
    const y = Float64Array.from([0.5, 0.5, 0.5, 0.5]);
    expect(interpolateCrossingTime(times, y, 2, 0.4)).toBeNull();
  });
});

describe('detectFootEvents + reconstructJumps (pipeline complet)', () => {
  it('reconstruit une série de 10 pogo jumps sans doublons', () => {
    const { y, times } = buildTrajectory(11); // 11 contacts → 10 sauts
    const smoothed = smooth(y, 5);
    const ground = estimateGroundLine(smoothed, times);
    const epsilon = adaptiveEpsilon(smoothed, ground);
    const events = detectFootEvents(times, smoothed, ground, epsilon);
    const { jumps, rejected } = reconstructJumps(events, times);

    expect(rejected).toHaveLength(0);
    expect(jumps).toHaveLength(10);

    // Cyclique : l'atterrissage final du saut k est le premier contact
    // du saut k+1 (même frame) — aucune duplication d'événement
    for (let k = 1; k < jumps.length; k++) {
      expect(jumps[k].landingFrame).toBe(jumps[k - 1].finalLandingFrame);
    }
  });

  it('métriques cohérentes : contact ~125 ms, vol ~350 ms', () => {
    const { y, times, contactFrames, flightFrames } = buildTrajectory(4);
    const smoothed = smooth(y, 5);
    const ground = estimateGroundLine(smoothed, times);
    const epsilon = adaptiveEpsilon(smoothed, ground);
    const events = detectFootEvents(times, smoothed, ground, epsilon);
    const { jumps } = reconstructJumps(events, times);

    expect(jumps.length).toBeGreaterThan(0);
    for (const jump of jumps) {
      const contactMs = (jump.takeoffTime - jump.landingTime) * 1000;
      const flightMs = (jump.finalLandingTime - jump.takeoffTime) * 1000;
      // Tolérance ±3 frames
      expect(contactMs).toBeGreaterThan(((contactFrames - 3) / FPS) * 1000);
      expect(contactMs).toBeLessThan(((contactFrames + 3) / FPS) * 1000);
      expect(flightMs).toBeGreaterThan(((flightFrames - 4) / FPS) * 1000);
      expect(flightMs).toBeLessThan(((flightFrames + 4) / FPS) * 1000);
    }
  });

  it('ignore le vol initial et le contact final incomplet', () => {
    const { y, times } = buildTrajectory(3);
    const smoothed = smooth(y, 5);
    const ground = estimateGroundLine(smoothed, times);
    const epsilon = adaptiveEpsilon(smoothed, ground);
    const events = detectFootEvents(times, smoothed, ground, epsilon);
    const { jumps } = reconstructJumps(events, times);
    // 3 contacts → 2 sauts (le contact final, non suivi d'un vol, est ignoré)
    expect(jumps).toHaveLength(2);
  });
});

describe('reconstructJumps (événements synthétiques, cas limites)', () => {
  const mkEvents = (specs: Array<[FootEventType, number, number | null]>): FootEvent[] =>
    specs.map(([type, frame, time]) => ({ type, frame, time, visibility: 0.9 }));

  it('signale (mais propose) un contact trop court (< 80 ms)', () => {
    const events = mkEvents([
      ['first-contact', 100, frameTime(100)],
      ['last-contact', 110, frameTime(110)], // ~42 ms de contact
      ['first-contact', 250, frameTime(250)],
    ]);
    const times = Float64Array.from({ length: 400 }, (_, i) => frameTime(i));
    const { jumps, rejected } = reconstructJumps(events, times);
    // Le cycle reste proposé (avec avertissement) : le supprimer
    // casserait le partage des contacts entre sauts successifs.
    expect(jumps).toHaveLength(1);
    expect(rejected).toHaveLength(0);
    expect(jumps[0].warning).toContain('contact');
  });

  it('signale (mais propose) un contact trop long (> 400 ms)', () => {
    const events = mkEvents([
      ['first-contact', 100, frameTime(100)],
      ['last-contact', 250, frameTime(250)], // 625 ms de contact
      ['first-contact', 400, frameTime(400)],
    ]);
    const times = Float64Array.from({ length: 500 }, (_, i) => frameTime(i));
    const { jumps, rejected } = reconstructJumps(events, times);
    expect(jumps).toHaveLength(1);
    expect(rejected).toHaveLength(0);
    expect(jumps[0].warning).toContain('> 400');
  });

  it('signale (mais propose) un vol trop court (< 100 ms) et trop long (> 600 ms)', () => {
    const times = Float64Array.from({ length: 600 }, (_, i) => frameTime(i));
    const tooShort = mkEvents([
      ['first-contact', 100, frameTime(100)],
      ['last-contact', 130, frameTime(130)],
      ['first-contact', 140, frameTime(140)], // vol ~42 ms
    ]);
    const short = reconstructJumps(tooShort, times);
    expect(short.jumps).toHaveLength(1);
    expect(short.jumps[0].warning).toContain('vol');

    const tooLong = mkEvents([
      ['first-contact', 100, frameTime(100)],
      ['last-contact', 130, frameTime(130)],
      ['first-contact', 400, frameTime(400)], // vol ~1125 ms
    ]);
    const long = reconstructJumps(tooLong, times);
    expect(long.jumps).toHaveLength(1);
    expect(long.jumps[0].warning).toContain('vol');
  });

  it('préserve le partage des contacts même avec un cycle hors bornes au milieu', () => {
    // Saut 1 conforme, saut 2 hors bornes (contact trop court), saut 3 conforme :
    // les trois sauts sont proposés et les contacts restent partagés.
    const events = mkEvents([
      ['first-contact', 100, frameTime(100)],
      ['last-contact', 130, frameTime(130)],  // saut 1 : contact 125 ms ✓
      ['first-contact', 214, frameTime(214)], // vol 350 ms ✓
      ['last-contact', 220, frameTime(220)],  // saut 2 : contact 25 ms ⚠
      ['first-contact', 304, frameTime(304)], // vol 350 ms ✓
      ['last-contact', 334, frameTime(334)],  // saut 3 : contact 125 ms ✓
      ['first-contact', 418, frameTime(418)], // vol 350 ms ✓
    ]);
    const times = Float64Array.from({ length: 500 }, (_, i) => frameTime(i));
    const { jumps, rejected } = reconstructJumps(events, times);
    expect(rejected).toHaveLength(0);
    expect(jumps).toHaveLength(3);
    expect(jumps[0].warning).toBeNull();
    expect(jumps[1].warning).toContain('contact');
    expect(jumps[2].warning).toBeNull();
    // Invariant clé : l'atterrissage final du saut k EST l'atterrissage du
    // saut k+1, même quand un cycle intermédiaire est hors bornes.
    for (let k = 1; k < jumps.length; k++) {
      expect(jumps[k].landingFrame).toBe(jumps[k - 1].finalLandingFrame);
    }
  });

  it('rejette les événements chevauchants (temps négatif)', () => {
    const events = mkEvents([
      ['first-contact', 200, frameTime(200)],
      ['last-contact', 150, frameTime(150)], // après le premier contact → négatif
      ['first-contact', 300, frameTime(300)],
    ]);
    const times = Float64Array.from({ length: 400 }, (_, i) => frameTime(i));
    const { jumps, rejected } = reconstructJumps(events, times);
    expect(jumps).toHaveLength(0);
    expect(rejected[0].reason).toContain('chevauchant');
  });

  it('ignore le vol initial : la timeline commence au premier contact', () => {
    const events = mkEvents([
      ['last-contact', 10, frameTime(10)], // décollage sans atterrissage avant
      ['first-contact', 100, frameTime(100)],
      ['last-contact', 130, frameTime(130)],
      ['first-contact', 214, frameTime(214)],
    ]);
    const times = Float64Array.from({ length: 400 }, (_, i) => frameTime(i));
    const { jumps } = reconstructJumps(events, times);
    expect(jumps).toHaveLength(1);
    expect(jumps[0].landingFrame).toBe(100);
  });

  it('s\'arrête au contact final non suivi d\'un vol complet', () => {
    const events = mkEvents([
      ['first-contact', 100, frameTime(100)],
      ['last-contact', 130, frameTime(130)],
      ['first-contact', 214, frameTime(214)],
      ['last-contact', 244, frameTime(244)],
      // PAS de premier contact ensuite : contact final incomplet
    ]);
    const times = Float64Array.from({ length: 400 }, (_, i) => frameTime(i));
    const { jumps } = reconstructJumps(events, times);
    expect(jumps).toHaveLength(1);
    expect(jumps[0].finalLandingFrame).toBe(214);
  });
});
