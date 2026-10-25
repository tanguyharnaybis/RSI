/**
 * Tests unitaires de la détection de frames dupliquées
 */

import { describe, it, expect } from 'vitest';
import { diffRatio, computeDuplicationHint, computeConfirmedDuplicationFactor } from '../src/video/frameDiff';

describe('diffRatio', () => {
  it('devrait retourner 0 pour des empreintes identiques', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    const b = new Uint8Array([10, 20, 30, 40]);
    expect(diffRatio(a, b)).toBe(0);
  });

  it('devrait retourner 1 pour des empreintes complètement différentes', () => {
    const a = new Uint8Array([0, 0, 0, 0]);
    const b = new Uint8Array([255, 255, 255, 255]);
    expect(diffRatio(a, b)).toBe(1);
  });

  it('devrait retourner une différence relative exacte', () => {
    // Différence : 51 sur 4 pixels → 51×4 / (255×4) = 0.2
    const a = new Uint8Array([0, 0, 0, 0]);
    const b = new Uint8Array([51, 51, 51, 51]);
    expect(diffRatio(a, b)).toBeCloseTo(0.2, 5);
  });

  it('devrait détecter des samples dupliqués (diff ≈ 0) sous le seuil', () => {
    // Samples dupliqués = même sample encodé → identiques, à un léger
    // bruit de décodage près sur quelques pixels isolés
    const a = new Uint8Array(1296).fill(128);
    const b = new Uint8Array(1296).fill(128);
    for (let i = 0; i < 1296; i += 100) {
      b[i] += 2;
    }
    expect(diffRatio(a, b)).toBeLessThan(0.0004);
  });

  it('devrait détecter des vraies frames en mouvement (diff > seuil)', () => {
    // Un mouvement léger : 2% des pixels changent de 25 niveaux
    const a = new Uint8Array(1296).fill(100);
    const b = new Uint8Array(1296).fill(100);
    for (let i = 0; i < 26; i++) {
      b[i] = 125;
    }
    expect(diffRatio(a, b)).toBeGreaterThan(0.0004);
  });
});

describe('computeDuplicationHint', () => {
  it('devrait retourner 1 sans observations', () => {
    expect(computeDuplicationHint([])).toBe(1);
  });

  it('devrait retourner le mode des distances', () => {
    expect(computeDuplicationHint([8, 8, 8, 1])).toBe(8);
  });

  it('devrait retourner 1 si les distances sont toutes 1', () => {
    expect(computeDuplicationHint([1, 1, 1, 1, 1])).toBe(1);
  });
});

describe('computeConfirmedDuplicationFactor', () => {
  it('ne devrait PAS confirmer avec moins de 3 observations', () => {
    expect(computeConfirmedDuplicationFactor([8, 8])).toBe(1);
  });

  it('ne devrait PAS confirmer si le mode est minoritaire', () => {
    expect(computeConfirmedDuplicationFactor([8, 1, 1, 1, 1, 1])).toBe(1);
  });

  it('devrait confirmer une duplication systématique ×8', () => {
    expect(computeConfirmedDuplicationFactor([8, 8, 8, 8, 8])).toBe(8);
  });

  it('devrait confirmer malgré quelques observations aberrantes', () => {
    expect(computeConfirmedDuplicationFactor([8, 8, 8, 1, 8, 8, 8, 1])).toBe(8);
  });

  it('devrait retourner 1 pour une vidéo sans duplication', () => {
    expect(computeConfirmedDuplicationFactor([1, 1, 2, 1, 1, 1, 1, 1, 1, 1])).toBe(1);
  });
});
