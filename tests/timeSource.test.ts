/**
 * Tests unitaires de la détermination de la source des temps réels
 */

import { describe, it, expect } from 'vitest';
import { determineTimeFactor } from '../src/calculation/timeSource';

describe('determineTimeFactor', () => {
  it('fichier à cadence de capture (iPhone original 240 fps) : FPS saisi ignoré', () => {
    const result = determineTimeFactor(240, 1, 240);
    expect(result.factor).toBe(1);
    expect(result.source).toBe('timestamps');
    expect(result.label).toContain('FPS saisi ignoré');
  });

  it('cadence de capture : même un FPS saisi erroné ne change rien', () => {
    // L'utilisateur saisit 480 au lieu de 240 : les temps restent exacts
    const result = determineTimeFactor(240, 1, 480);
    expect(result.factor).toBe(1);
    expect(result.source).toBe('timestamps');
  });

  it('conteneur à cadence de capture avec duplication ×8 : détection automatique', () => {
    // Export dupliqué (conteneur 240, 8 copies par frame réelle)
    const result = determineTimeFactor(240, 8, 240);
    expect(result.factor).toBe(8);
    expect(result.source).toBe('timestamps');
    expect(result.label).toContain('×8');
    expect(result.label).toContain('FPS saisi ignoré');
  });

  it('export étiré à conteneur lent (30 fps) : FPS saisi requis (×8)', () => {
    const result = determineTimeFactor(30, 1, 240);
    expect(result.factor).toBe(8);
    expect(result.source).toBe('manual-fps');
    expect(result.label).toContain('240');
  });

  it('vidéo normale à cadence lente avec FPS saisi cohérent : facteur 1', () => {
    // Vidéo iPhone normale 30 fps, l'utilisateur saisit 30
    const result = determineTimeFactor(30, 1, 30);
    expect(result.factor).toBe(1);
    expect(result.source).toBe('manual-fps');
  });

  it('export étiré avec duplication : facteur combiné', () => {
    // Conteneur 30 fps, saisie 240, duplication ×2 confirmée
    const result = determineTimeFactor(30, 2, 240);
    expect(result.factor).toBe(16);
    expect(result.source).toBe('manual-fps');
  });

  it('FPS saisi inférieur à la cadence conteneur : facteur plancher 1', () => {
    const result = determineTimeFactor(60, 1, 30);
    expect(result.factor).toBe(1);
  });

  it('cadence conteneur inconnue (0) : repli FPS saisi', () => {
    const result = determineTimeFactor(0, 1, 240);
    expect(result.source).toBe('manual-fps');
    expect(result.label).toContain('240');
  });
});
