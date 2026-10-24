/**
 * Module de stockage local (localStorage)
 * Gère la persistance des sessions et essais
 */

import type { Session, Trial, StorageService } from '../types';

// Clé de stockage dans localStorage
const STORAGE_KEY = 'rsi_calc_sessions';

/**
 * Service de stockage local
 */
export class LocalStorageService implements StorageService {
  /**
   * Charge toutes les sessions depuis localStorage
   * @returns Promise avec toutes les sessions
   */
  private async loadAll(): Promise<Session[]> {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) {
        return [];
      }
      
      const parsed = JSON.parse(data);
      
      // Valider et migrer les données si nécessaire
      return this.migrateData(parsed);
    } catch (error) {
      console.error('Erreur lors du chargement des sessions:', error);
      return [];
    }
  }

  /**
   * Sauvegarde toutes les sessions dans localStorage
   * @param sessions - Sessions à sauvegarder
   */
  private async saveAll(sessions: Session[]): Promise<void> {
    try {
      const data = JSON.stringify(sessions);
      localStorage.setItem(STORAGE_KEY, data);
    } catch (error) {
      console.error('Erreur lors de la sauvegarde des sessions:', error);
      throw error;
    }
  }

  /**
   * Migre les données anciennes vers le nouveau format
   * @param data - Données à migrer
   * @returns Sessions migrées
   */
  private migrateData(data: any): Session[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map(session => {
      // S'assurer que tous les champs nécessaires sont présents
      return {
        id: session.id || this.generateId(),
        name: session.name || 'Session sans nom',
        dropHeightCm: session.dropHeightCm || 0,
        date: session.date || new Date().toISOString().split('T')[0],
        trials: session.trials || [],
        createdAt: session.createdAt || Date.now(),
        updatedAt: session.updatedAt || Date.now(),
      };
    });
  }

  /**
   * Génère un ID unique
   * @returns ID unique
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Sauvegarde une session
   * @param session - Session à sauvegarder
   * @returns Promise avec la session sauvegardée
   */
  async saveSession(session: Session): Promise<Session> {
    const sessions = await this.loadAll();
    
    // Vérifier si la session existe déjà
    const existingIndex = sessions.findIndex(s => s.id === session.id);
    
    if (existingIndex >= 0) {
      // Mettre à jour la session existante
      sessions[existingIndex] = {
        ...sessions[existingIndex],
        ...session,
        updatedAt: Date.now(),
      };
    } else {
      // Ajouter une nouvelle session
      const newSession = {
        ...session,
        id: session.id || this.generateId(),
        createdAt: session.createdAt || Date.now(),
        updatedAt: session.updatedAt || Date.now(),
      };
      sessions.push(newSession);
    }
    
    await this.saveAll(sessions);
    return sessions.find(s => s.id === session.id)!;
  }

  /**
   * Récupère une session par ID
   * @param sessionId - ID de la session
   * @returns Promise avec la session ou null
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const sessions = await this.loadAll();
    return sessions.find(s => s.id === sessionId) || null;
  }

  /**
   * Récupère toutes les sessions
   * @returns Promise avec toutes les sessions
   */
  async getAllSessions(): Promise<Session[]> {
    return this.loadAll();
  }

  /**
   * Supprime une session
   * @param sessionId - ID de la session à supprimer
   * @returns Promise
   */
  async deleteSession(sessionId: string): Promise<void> {
    const sessions = await this.loadAll();
    const filtered = sessions.filter(s => s.id !== sessionId);
    await this.saveAll(filtered);
  }

  /**
   * Met à jour un essai dans une session
   * @param sessionId - ID de la session
   * @param trial - Essai à mettre à jour
   * @returns Promise avec l'essai mis à jour
   */
  async updateTrial(sessionId: string, trial: Trial): Promise<Trial> {
    const sessions = await this.loadAll();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    
    if (sessionIndex < 0) {
      throw new Error(`Session non trouvée: ${sessionId}`);
    }
    
    const trialIndex = sessions[sessionIndex].trials.findIndex(t => t.id === trial.id);
    
    if (trialIndex < 0) {
      // Ajouter un nouvel essai
      const newTrial = {
        ...trial,
        id: trial.id || this.generateId(),
      };
      sessions[sessionIndex].trials.push(newTrial);
    } else {
      // Mettre à jour l'essai existant
      sessions[sessionIndex].trials[trialIndex] = {
        ...sessions[sessionIndex].trials[trialIndex],
        ...trial,
      };
    }
    
    sessions[sessionIndex].updatedAt = Date.now();
    await this.saveAll(sessions);
    
    return sessions[sessionIndex].trials.find(t => t.id === trial.id)!;
  }

  /**
   * Ajoute un essai à une session
   * @param sessionId - ID de la session
   * @param trial - Essai à ajouter
   * @returns Promise avec l'essai ajouté
   */
  async addTrial(sessionId: string, trial: Trial): Promise<Trial> {
    const sessions = await this.loadAll();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    
    if (sessionIndex < 0) {
      throw new Error(`Session non trouvée: ${sessionId}`);
    }
    
    const newTrial = {
      ...trial,
      id: trial.id || this.generateId(),
      sessionId,
      timestamp: trial.timestamp || Date.now(),
    };
    
    sessions[sessionIndex].trials.push(newTrial);
    sessions[sessionIndex].updatedAt = Date.now();
    
    await this.saveAll(sessions);
    
    return newTrial;
  }

  /**
   * Supprime un essai d'une session
   * @param sessionId - ID de la session
   * @param trialId - ID de l'essai
   * @returns Promise
   */
  async deleteTrial(sessionId: string, trialId: string): Promise<void> {
    const sessions = await this.loadAll();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    
    if (sessionIndex < 0) {
      throw new Error(`Session non trouvée: ${sessionId}`);
    }
    
    sessions[sessionIndex].trials = sessions[sessionIndex].trials.filter(
      t => t.id !== trialId
    );
    sessions[sessionIndex].updatedAt = Date.now();
    
    await this.saveAll(sessions);
  }

  /**
   * Exporte toutes les sessions en JSON
   * @returns Promise avec la chaîne JSON
   */
  async exportToJSON(): Promise<string> {
    const sessions = await this.loadAll();
    return JSON.stringify(sessions, null, 2);
  }

  /**
   * Exporte une session en JSON
   * @param sessionId - ID de la session
   * @returns Promise avec la chaîne JSON
   */
  async exportSessionToJSON(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session non trouvée: ${sessionId}`);
    }
    return JSON.stringify(session, null, 2);
  }

  /**
   * Importe des sessions depuis JSON
   * @param json - Chaîne JSON
   * @returns Promise avec les sessions importées
   */
  async importFromJSON(json: string): Promise<Session[]> {
    try {
      const data = JSON.parse(json);
      
      if (!Array.isArray(data)) {
        throw new Error('Format JSON invalide');
      }
      
      const sessions = await this.loadAll();
      
      // Ajouter les nouvelles sessions (éviter les doublons)
      data.forEach(newSession => {
        if (!sessions.some(s => s.id === newSession.id)) {
          sessions.push({
            ...newSession,
            id: newSession.id || this.generateId(),
            updatedAt: Date.now(),
          });
        }
      });
      
      await this.saveAll(sessions);
      return sessions;
    } catch (error) {
      console.error('Erreur lors de l\'import JSON:', error);
      throw error;
    }
  }

  /**
   * Exporte toutes les sessions en CSV
   * @returns Promise avec la chaîne CSV
   */
  async exportToCSV(): Promise<string> {
    const sessions = await this.loadAll();
    const csv: string[] = [];
    
    // En-tête
    csv.push(['Session', 'Date', 'Hauteur Drop (cm)', 'Essai #', 'Temps Contact (ms)', 'Temps Vol (ms)', 'Hauteur (cm)', 'RSI', 'RSI Modifié'].join(';'));
    
    // Données
    sessions.forEach(session => {
      session.trials.forEach((trial, index) => {
        csv.push([
          session.name,
          session.date,
          session.dropHeightCm,
          index + 1,
          trial.formattedResult.contactTimeMs,
          trial.formattedResult.flightTimeMs,
          trial.formattedResult.heightCm,
          trial.formattedResult.rsi,
          trial.formattedResult.modifiedRsi,
        ].join(';'));
      });
    });
    
    return csv.join('\n');
  }

  /**
   * Exporte une session en CSV
   * @param sessionId - ID de la session
   * @returns Promise avec la chaîne CSV
   */
  async exportSessionToCSV(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session non trouvée: ${sessionId}`);
    }
    
    const csv: string[] = [];
    
    // En-tête
    csv.push(['Essai #', 'Temps Contact (ms)', 'Temps Vol (ms)', 'Hauteur (cm)', 'RSI', 'RSI Modifié'].join(';'));
    
    // Données
    session.trials.forEach((trial, index) => {
      csv.push([
        index + 1,
        trial.formattedResult.contactTimeMs,
        trial.formattedResult.flightTimeMs,
        trial.formattedResult.heightCm,
        trial.formattedResult.rsi,
        trial.formattedResult.modifiedRsi,
      ].join(';'));
    });
    
    return csv.join('\n');
  }

  /**
   * Nettoie toutes les données
   * @returns Promise
   */
  async clearAll(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Obtient des statistiques sur toutes les sessions
   * @returns Promise avec les statistiques
   */
  async getStatistics(): Promise<{
    totalSessions: number;
    totalTrials: number;
    averageRsi: number;
    highestRsi: number;
  }> {
    const sessions = await this.loadAll();
    const totalTrials = sessions.reduce((sum, s) => sum + s.trials.length, 0);
    
    const allRsi: number[] = [];
    sessions.forEach(session => {
      session.trials.forEach(trial => {
        allRsi.push(trial.formattedResult.rsi);
      });
    });
    
    const averageRsi = allRsi.length > 0 
      ? allRsi.reduce((sum, r) => sum + r, 0) / allRsi.length
      : 0;
    
    const highestRsi = allRsi.length > 0 ? Math.max(...allRsi) : 0;
    
    return {
      totalSessions: sessions.length,
      totalTrials,
      averageRsi: parseFloat(averageRsi.toFixed(2)),
      highestRsi: parseFloat(highestRsi.toFixed(2)),
    };
  }
}

/**
 * Crée un nouveau service de stockage local
 * @returns Nouveau service
 */
export function createLocalStorageService(): LocalStorageService {
  return new LocalStorageService();
}
