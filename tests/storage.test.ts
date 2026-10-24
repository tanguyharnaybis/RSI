/**
 * Tests unitaires pour le module de stockage
 */

import { describe, it, expect, vi } from 'vitest';
import { 
  createSession, 
  createTrialFromMarkers, 
  updateSession,
  addTrialToSession,
  removeTrialFromSession,
  validateSession,
  validateTrial,
  getSessionStats
} from '../src/storage/session';
import type { Session, Trial, MarkerPoints, VideoMetadata } from '../src/types';

// Mock pour VideoFrame
const mockFrame = (frameNumber: number): any => ({
  frameNumber,
  timestamp: frameNumber / 240,
});

// Mock pour MarkerPoints
const mockMarkers: MarkerPoints = {
  landing: mockFrame(100),
  takeoff: mockFrame(120),
  finalLanding: mockFrame(150),
};

// Mock pour VideoMetadata
const mockMetadata: VideoMetadata = {
  duration: 1.0,
  fps: 240,
  frameCount: 240,
  width: 1920,
  height: 1080,
  isSlowMotion: true,
  detectedFps: 240,
};

describe('createSession', () => {
  it('devrait créer une session avec des paramètres valides', () => {
    const session = createSession('Test Session', 40);
    
    expect(session.id).toBeDefined();
    expect(session.name).toBe('Test Session');
    expect(session.dropHeightCm).toBe(40);
    expect(session.date).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(session.trials).toEqual([]);
    expect(session.createdAt).toBeDefined();
    expect(session.updatedAt).toBeDefined();
  });

  it('devrait créer une session avec des valeurs par défaut', () => {
    const session = createSession('', 0);
    
    expect(session.name).toBe('');
    expect(session.dropHeightCm).toBe(0);
  });

  it('devrait générer des IDs uniques', () => {
    const session1 = createSession('Session 1', 30);
    const session2 = createSession('Session 2', 40);
    
    expect(session1.id).not.toBe(session2.id);
  });
});

describe('createTrialFromMarkers', () => {
  it('devrait créer un essai à partir de marqueurs valides', () => {
    const trial = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    
    expect(trial.id).toBeDefined();
    expect(trial.sessionId).toBe('session-1');
    expect(trial.markers).toEqual(mockMarkers);
    expect(trial.metadata.fps).toBe(240);
    expect(trial.metadata.frameCount).toBe(240);
    expect(trial.result).toBeDefined();
    expect(trial.formattedResult).toBeDefined();
    expect(trial.timestamp).toBeDefined();
  });

  it('devrait calculer les résultats correctement', () => {
    const trial = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    
    // Vérifier que le calcul a été effectué
    expect(trial.result.contactTime).toBeCloseTo(20 / 240, 5);
    expect(trial.result.flightTime).toBeCloseTo(30 / 240, 5);
    expect(trial.result.height).toBeGreaterThan(0);
    expect(trial.result.rsi).toBeGreaterThan(0);
  });

  it('devrait utiliser la gravité personnalisée', () => {
    const gravity = 10;
    const trial = createTrialFromMarkers('session-1', mockMarkers, mockMetadata, gravity);
    
    // Le résultat devrait être différent avec gravité = 10
    expect(trial.result.height).toBeCloseTo(
      10 * Math.pow((30 / 240), 2) / 8,
      3
    );
  });
});

describe('updateSession', () => {
  it('devrait mettre à jour une session', () => {
    const session = createSession('Original', 30);
    const updatedAt = Date.now();
    
    // Simuler un délai
    vi.useFakeTimers();
    vi.setSystemTime(new Date(updatedAt + 1000));
    
    const updated = updateSession(session, { name: 'Updated' });
    
    expect(updated.name).toBe('Updated');
    expect(updated.dropHeightCm).toBe(30);
    expect(updated.updatedAt).toBeGreaterThan(session.updatedAt);
    
    vi.useRealTimers();
  });

  it('devrait fusionner les mises à jour', () => {
    const session = createSession('Original', 30);
    
    const updated = updateSession(session, { 
      name: 'Updated', 
      dropHeightCm: 50 
    });
    
    expect(updated.name).toBe('Updated');
    expect(updated.dropHeightCm).toBe(50);
  });
});

describe('addTrialToSession', () => {
  it('devrait ajouter un essai à une session', () => {
    const session = createSession('Test', 30);
    const trial = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    
    const updated = addTrialToSession(session, trial);
    
    expect(updated.trials).toHaveLength(1);
    expect(updated.trials[0]).toEqual(trial);
    // updatedAt est toujours >= (les tests s'exécutent parfois dans la même ms)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
  });

  it('devrait ajouter plusieurs essais', () => {
    const session = createSession('Test', 30);
    const trial1 = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    const trial2 = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    
    let updated = addTrialToSession(session, trial1);
    updated = addTrialToSession(updated, trial2);
    
    expect(updated.trials).toHaveLength(2);
  });
});

describe('removeTrialFromSession', () => {
  it('devrait supprimer un essai d\'une session', () => {
    const session = createSession('Test', 30);
    const trial1 = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    const trial2 = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    
    let updated = addTrialToSession(session, trial1);
    updated = addTrialToSession(updated, trial2);
    
    const final = removeTrialFromSession(updated, trial1.id);
    
    expect(final.trials).toHaveLength(1);
    expect(final.trials[0].id).toBe(trial2.id);
  });

  it('devrait ne rien faire si l\'essai n\'existe pas', () => {
    const session = createSession('Test', 30);
    const trial = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    
    const updated = addTrialToSession(session, trial);
    const final = removeTrialFromSession(updated, 'non-existent-id');
    
    expect(final.trials).toHaveLength(1);
  });
});

describe('validateSession', () => {
  it('devrait valider une session valide', () => {
    const session: Partial<Session> = {
      name: 'Valid Session',
      dropHeightCm: 30,
    };
    
    expect(validateSession(session)).toBe(true);
  });

  it('devrait invalider si le nom manque', () => {
    const session: Partial<Session> = {
      dropHeightCm: 30,
    };
    
    expect(validateSession(session)).toBe(false);
  });

  it('devrait invalider si dropHeightCm manque', () => {
    const session: Partial<Session> = {
      name: 'Valid Session',
    };
    
    expect(validateSession(session)).toBe(false);
  });

  it('devrait invalider si dropHeightCm <= 0', () => {
    const session: Partial<Session> = {
      name: 'Valid Session',
      dropHeightCm: -10,
    };
    
    expect(validateSession(session)).toBe(false);
  });

  it('devrait invalider si le nom n\'est pas une chaîne', () => {
    const session: Partial<Session> = {
      name: 123 as any,
      dropHeightCm: 30,
    };
    
    expect(validateSession(session)).toBe(false);
  });

  it('devrait invalider si dropHeightCm n\'est pas un nombre', () => {
    const session: Partial<Session> = {
      name: 'Valid Session',
      dropHeightCm: '30' as any,
    };
    
    expect(validateSession(session)).toBe(false);
  });
});

describe('validateTrial', () => {
  it('devrait valider un essai valide', () => {
    const trial: Partial<Trial> = {
      result: {
        contactTime: 0.1,
        flightTime: 0.2,
        height: 0.1,
        rsi: 1.0,
        modifiedRsi: 0.5,
        totalTime: 0.3,
      },
      formattedResult: {
        contactTimeMs: 100,
        flightTimeMs: 200,
        heightCm: 10,
        rsi: 1.0,
        modifiedRsi: 0.5,
      },
      metadata: {
        fps: 240,
        frameCount: 240,
      } as any,
    };
    
    expect(validateTrial(trial)).toBe(true);
  });

  it('devrait invalider si result manque', () => {
    const trial: Partial<Trial> = {
      formattedResult: {
        contactTimeMs: 100,
        flightTimeMs: 200,
        heightCm: 10,
        rsi: 1.0,
        modifiedRsi: 0.5,
      },
      metadata: {
        fps: 240,
      } as any,
    };
    
    expect(validateTrial(trial)).toBe(false);
  });

  it('devrait invalider si formattedResult manque', () => {
    const trial: Partial<Trial> = {
      result: {
        contactTime: 0.1,
        flightTime: 0.2,
        height: 0.1,
        rsi: 1.0,
        modifiedRsi: 0.5,
        totalTime: 0.3,
      },
      metadata: {
        fps: 240,
      } as any,
    };
    
    expect(validateTrial(trial)).toBe(false);
  });

  it('devrait invalider si fps <= 0', () => {
    const trial: Partial<Trial> = {
      result: {
        contactTime: 0.1,
        flightTime: 0.2,
        height: 0.1,
        rsi: 1.0,
        modifiedRsi: 0.5,
        totalTime: 0.3,
      },
      formattedResult: {
        contactTimeMs: 100,
        flightTimeMs: 200,
        heightCm: 10,
        rsi: 1.0,
        modifiedRsi: 0.5,
      },
      metadata: {
        fps: 0,
      } as any,
    };
    
    expect(validateTrial(trial)).toBe(false);
  });
});

describe('getSessionStats', () => {
  it('devrait calculer les statistiques d\'une session vide', () => {
    const session = createSession('Empty Session', 30);
    const stats = getSessionStats(session);
    
    expect(stats.sessionId).toBe(session.id);
    expect(stats.trialCount).toBe(0);
    expect(stats.meanRsi).toBe(0);
    expect(stats.stdDevRsi).toBe(0);
  });

  it('devrait calculer les statistiques avec un essai', () => {
    const session = createSession('Single Trial', 30);
    const trial = createTrialFromMarkers('session-1', mockMarkers, mockMetadata);
    const sessionWithTrial = addTrialToSession(session, trial);
    
    const stats = getSessionStats(sessionWithTrial);
    
    expect(stats.trialCount).toBe(1);
    expect(stats.meanRsi).toBeCloseTo(trial.formattedResult.rsi, 3);
    expect(stats.stdDevRsi).toBe(0);
  });

  it('devrait calculer les statistiques avec plusieurs essais', () => {
    const session = createSession('Multiple Trials', 30);
    
    // Créer 3 essais avec des résultats différents
    const markers1: MarkerPoints = {
      landing: mockFrame(100),
      takeoff: mockFrame(120),
      finalLanding: mockFrame(150),
    };
    
    const markers2: MarkerPoints = {
      landing: mockFrame(100),
      takeoff: mockFrame(125),
      finalLanding: mockFrame(160),
    };
    
    const markers3: MarkerPoints = {
      landing: mockFrame(100),
      takeoff: mockFrame(130),
      finalLanding: mockFrame(170),
    };
    
    const trial1 = createTrialFromMarkers(session.id, markers1, mockMetadata);
    const trial2 = createTrialFromMarkers(session.id, markers2, mockMetadata);
    const trial3 = createTrialFromMarkers(session.id, markers3, mockMetadata);
    
    let sessionWithTrials = addTrialToSession(session, trial1);
    sessionWithTrials = addTrialToSession(sessionWithTrials, trial2);
    sessionWithTrials = addTrialToSession(sessionWithTrials, trial3);
    
    const stats = getSessionStats(sessionWithTrials);
    
    expect(stats.trialCount).toBe(3);
    expect(stats.meanRsi).toBeGreaterThan(0);
    expect(stats.stdDevRsi).toBeGreaterThanOrEqual(0);
  });
});
