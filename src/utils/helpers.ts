/**
 * Module d'utilitaires divers
 */

/**
 * Formate un nombre avec un nombre fixe de décimales
 * @param value - Nombre à formater
 * @param decimals - Nombre de décimales
 * @returns Chaîne formatée
 */
export function formatNumber(value: number, decimals: number = 2): string {
  return value.toFixed(decimals);
}

/**
 * Formate une date pour affichage
 * @param date - Date à formater
 * @param format - Format (ex: 'DD/MM/YYYY', 'YYYY-MM-DD')
 * @returns Chaîne formatée
 */
export function formatDate(date: Date | number | string, format: string = 'DD/MM/YYYY'): string {
  const d = new Date(date);
  
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  
  const formats: Record<string, string> = {
    'DD/MM/YYYY': `${day}/${month}/${year}`,
    'MM/DD/YYYY': `${month}/${day}/${year}`,
    'YYYY-MM-DD': `${year}-${month}-${day}`,
    'YYYY-MM-DD HH:mm': `${year}-${month}-${day} ${hours}:${minutes}`,
    'YYYY-MM-DD HH:mm:ss': `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
    'DD MMM YYYY': `${day} ${getMonthName(d.getMonth())} ${year}`,
  };
  
  return formats[format] || formats['DD/MM/YYYY'];
}

/**
 * Obtient le nom du mois
 * @param month - Index du mois (0-11)
 * @returns Nom du mois
 */
function getMonthName(month: number): string {
  const months = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
  ];
  return months[month] || '';
}

/**
 * Formate un temps en millisecondes en format lisible
 * @param ms - Temps en millisecondes
 * @returns Chaîne formatée
 */
export function formatTime(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)} ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)} s`;
  } else if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000);
    const seconds = (ms % 60000) / 1000;
    return `${minutes}m ${seconds.toFixed(1)}s`;
  } else {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = (ms % 60000) / 1000;
    return `${hours}h ${minutes}m ${seconds.toFixed(1)}s`;
  }
}

/**
 * Convertit une durée en format lisible
 * @param seconds - Durée en secondes
 * @returns Chaîne formatée
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs.toFixed(1)}s`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs.toFixed(1)}s`;
  }
}

/**
 * Génère un ID unique
 * @returns ID unique
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Génère un ID court
 * @returns ID court
 */
export function generateShortId(): string {
  return Math.random().toString(36).substring(2, 9);
}

/**
 * Clone un objet de manière profonde
 * @param obj - Objet à cloner
 * @returns Copie profonde
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as any;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item)) as any;
  }
  
  const clone: any = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      clone[key] = deepClone(obj[key]);
    }
  }
  return clone;
}

/**
 * Vérifie si deux objets sont égaux (comparaison profonde)
 * @param a - Premier objet
 * @param b - Deuxième objet
 * @returns Vrai si égaux
 */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  
  if (aKeys.length !== bKeys.length) return false;
  
  return aKeys.every(key => 
    bKeys.includes(key) && deepEqual(a[key], b[key])
  );
}

/**
 * Retarde l'exécution d'une fonction
 * @param ms - Délai en millisecondes
 * @returns Promise qui se résout après le délai
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exécute une fonction avec un délai de debounce
 * @param func - Fonction à exécuter
 * @param wait - Délai en millisecondes
 * @returns Fonction avec debounce
 */
export function debounce<T extends (...args: any[]) => void>(func: T, wait: number): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  
  return function(...args: Parameters<T>) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, wait);
  };
}

/**
 * Exécute une fonction avec un délai de throttle
 * @param func - Fonction à exécuter
 * @param limit - Délai en millisecondes
 * @returns Fonction avec throttle
 */
export function throttle<T extends (...args: any[]) => void>(func: T, limit: number): (...args: Parameters<T>) => void {
  let lastFunc: ReturnType<typeof setTimeout> | null = null;
  let lastRan = 0;
  
  return function(...args: Parameters<T>) {
    if (!lastRan) {
      func(...args);
      lastRan = Date.now();
    } else {
      if (lastFunc) {
        clearTimeout(lastFunc);
      }
      
      lastFunc = setTimeout(() => {
        if (Date.now() - lastRan >= limit) {
          func(...args);
          lastRan = Date.now();
        }
      }, limit - (Date.now() - lastRan));
    }
  };
}

/**
 * Limite une valeur entre un minimum et un maximum
 * @param value - Valeur à limiter
 * @param min - Minimum
 * @param max - Maximum
 * @returns Valeur limitée
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Formate un nombre de bytes en format lisible
 * @param bytes - Nombre de bytes
 * @returns Chaîne formatée
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Vérifie si un élément est dans le viewport
 * @param element - Élément à vérifier
 * @param threshold - Seuil (0-1)
 * @returns Vrai si visible
 */
export function isInViewport(element: HTMLElement, threshold: number = 0.5): boolean {
  const rect = element.getBoundingClientRect();
  const windowHeight = window.innerHeight || document.documentElement.clientHeight;
  
  return (
    rect.top <= windowHeight * (1 - threshold) &&
    rect.bottom >= windowHeight * threshold
  );
}

/**
 * Fait défiler vers un élément
 * @param element - Élément cible
 * @param options - Options de défilement
 */
export function scrollToElement(
  element: HTMLElement,
  options: ScrollIntoViewOptions = { behavior: 'smooth', block: 'start' }
): void {
  element.scrollIntoView(options);
}

/**
 * Formate une chaîne pour une URL
 * @param str - Chaîne à formater
 * @returns Chaîne formatée pour URL
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Capitalise la première lettre d'une chaîne
 * @param str - Chaîne à formater
 * @returns Chaîne capitalisée
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convertit un angle de degrés en radians
 * @param degrees - Angle en degrés
 * @returns Angle en radians
 */
export function degreesToRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Convertit un angle de radians en degrés
 * @param radians - Angle en radians
 * @returns Angle en degrés
 */
export function radiansToDegrees(radians: number): number {
  return radians * (180 / Math.PI);
}

/**
 * Vérifie si une valeur est un nombre
 * @param value - Valeur à vérifier
 * @returns Vrai si nombre
 */
export function isNumber(value: any): boolean {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
}

/**
 * Vérifie si une valeur est une chaîne
 * @param value - Valeur à vérifier
 * @returns Vrai si chaîne
 */
export function isString(value: any): boolean {
  return typeof value === 'string';
}

/**
 * Vérifie si une valeur est un objet
 * @param value - Valeur à vérifier
 * @returns Vrai si objet
 */
export function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Vérifie si une valeur est un tableau
 * @param value - Valeur à vérifier
 * @returns Vrai si tableau
 */
export function isArray(value: any): boolean {
  return Array.isArray(value);
}

/**
 * Vérifie si une valeur est une fonction
 * @param value - Valeur à vérifier
 * @returns Vrai si fonction
 */
export function isFunction(value: any): boolean {
  return typeof value === 'function';
}

/**
 * Vérifie si une valeur est vide
 * @param value - Valeur à vérifier
 * @returns Vrai si vide
 */
export function isEmpty(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (isString(value)) return value.trim() === '';
  if (isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Obtient le nom de l'extension d'un fichier
 * @param filename - Nom du fichier
 * @returns Extension
 */
export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.substring(lastDot + 1).toLowerCase() : '';
}

/**
 * Obtient le nom du fichier sans extension
 * @param filename - Nom du fichier
 * @returns Nom sans extension
 */
export function getFileNameWithoutExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.substring(0, lastDot) : filename;
}
