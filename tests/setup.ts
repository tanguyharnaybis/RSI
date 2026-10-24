/**
 * Configuration de test pour Vitest
 */

import { beforeAll, afterAll, afterEach, vi } from 'vitest';

// Mock pour les APIs DOM utilisées par le code applicatif
beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
  // Nettoyer localStorage entre les tests
  localStorage.clear();
});
