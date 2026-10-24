/**
 * Module de gestion du thème
 * Contient les styles CSS et la logique de thème sombre/clair
 */

// ============================================
// Styles CSS globaux
// ============================================

/**
 * Styles CSS de base pour l'application
 */
export const baseStyles = `
  /* Reset et styles de base */
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :root {
    /* Couleurs - thème sombre par défaut */
    --bg-primary: #1a1a2e;
    --bg-secondary: #16213e;
    --bg-tertiary: #0f3460;
    --bg-card: rgba(255, 255, 255, 0.05);
    
    --text-primary: #ffffff;
    --text-secondary: #b0b0b0;
    --text-muted: #6c6c6c;
    
    --primary: #e94560;
    --primary-dark: #c73e54;
    --secondary: #0f3460;
    --success: #4caf50;
    --warning: #ff9800;
    --danger: #f44336;
    
    --border: rgba(255, 255, 255, 0.1);
    --border-light: rgba(255, 255, 255, 0.2);
    
    --shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.5);
    
    /* Espacements */
    --spacing-xs: 0.25rem;
    --spacing-sm: 0.5rem;
    --spacing-md: 1rem;
    --spacing-lg: 1.5rem;
    --spacing-xl: 2rem;
    --spacing-2xl: 3rem;
    
    /* Bordures */
    --radius-sm: 0.25rem;
    --radius-md: 0.5rem;
    --radius-lg: 1rem;
    --radius-full: 9999px;
    
    /* Tailles de police */
    --font-xs: 0.75rem;
    --font-sm: 0.875rem;
    --font-base: 1rem;
    --font-lg: 1.125rem;
    --font-xl: 1.25rem;
    --font-2xl: 1.5rem;
    --font-3xl: 2rem;
    
    /* Transitions */
    --transition-fast: 150ms ease;
    --transition-normal: 250ms ease;
    --transition-slow: 350ms ease;
    
    /* Z-index */
    --z-modal: 1000;
    --z-tooltip: 1100;
    --z-loading: 1200;
  }

  /* Thème clair */
  .light-theme {
    --bg-primary: #f5f5f5;
    --bg-secondary: #ffffff;
    --bg-tertiary: #e0e0e0;
    --bg-card: #ffffff;
    
    --text-primary: #1a1a2e;
    --text-secondary: #4a4a4a;
    --text-muted: #8a8a8a;
    
    --primary: #e94560;
    --primary-dark: #c73e54;
    --secondary: #0f3460;
    --success: #4caf50;
    --warning: #ff9800;
    --danger: #f44336;
    
    --border: rgba(0, 0, 0, 0.1);
    --border-light: rgba(0, 0, 0, 0.2);
    
    --shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.15);
  }

  /* Styles globaux */
  html {
    font-size: 16px;
    scroll-behavior: smooth;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.6;
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Typographie */
  h1, h2, h3, h4, h5, h6 {
    font-weight: 600;
    line-height: 1.2;
    margin-bottom: var(--spacing-md);
  }

  h1 { font-size: var(--font-3xl); }
  h2 { font-size: var(--font-2xl); }
  h3 { font-size: var(--font-xl); }
  h4 { font-size: var(--font-lg); }

  p {
    margin-bottom: var(--spacing-md);
    color: var(--text-secondary);
  }

  a {
    color: var(--primary);
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  a:hover {
    color: var(--primary-dark);
  }

  /* Conteneurs */
  .container {
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 var(--spacing-lg);
  }

  .container-fluid {
    width: 100%;
    padding: 0 var(--spacing-lg);
  }

  /* Flex et Grid */
  .flex {
    display: flex;
  }

  .flex-col {
    flex-direction: column;
  }

  .flex-wrap {
    flex-wrap: wrap;
  }

  .justify-center { justify-content: center; }
  .justify-between { justify-content: space-between; }
  .justify-around { justify-content: space-around; }
  .justify-evenly { justify-content: space-evenly; }
  .items-center { align-items: center; }
  .items-start { align-items: flex-start; }

  .grid {
    display: grid;
  }

  .grid-cols-1 { grid-template-columns: 1fr; }
  .grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
  .grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
  .grid-cols-4 { grid-template-columns: repeat(4, 1fr); }

  .gap-xs { gap: var(--spacing-xs); }
  .gap-sm { gap: var(--spacing-sm); }
  .gap-md { gap: var(--spacing-md); }
  .gap-lg { gap: var(--spacing-lg); }

  /* Espacements */
  .m-0 { margin: 0; }
  .mt-xs { margin-top: var(--spacing-xs); }
  .mt-sm { margin-top: var(--spacing-sm); }
  .mt-md { margin-top: var(--spacing-md); }
  .mt-lg { margin-top: var(--spacing-lg); }
  .mt-xl { margin-top: var(--spacing-xl); }
  
  .mb-xs { margin-bottom: var(--spacing-xs); }
  .mb-sm { margin-bottom: var(--spacing-sm); }
  .mb-md { margin-bottom: var(--spacing-md); }
  .mb-lg { margin-bottom: var(--spacing-lg); }
  .mb-xl { margin-bottom: var(--spacing-xl); }

  .p-sm { padding: var(--spacing-sm); }
  .p-md { padding: var(--spacing-md); }
  .p-lg { padding: var(--spacing-lg); }

  /* Textes */
  .text-center { text-align: center; }
  .text-left { text-align: left; }
  .text-right { text-align: right; }

  .text-xs { font-size: var(--font-xs); }
  .text-sm { font-size: var(--font-sm); }
  .text-base { font-size: var(--font-base); }
  .text-lg { font-size: var(--font-lg); }
  .text-xl { font-size: var(--font-xl); }

  .text-primary { color: var(--text-primary); }
  .text-secondary { color: var(--text-secondary); }
  .text-muted { color: var(--text-muted); }
  .text-success { color: var(--success); }
  .text-warning { color: var(--warning); }
  .text-danger { color: var(--danger); }

  .font-bold { font-weight: 700; }
  .font-semibold { font-weight: 600; }
  .font-normal { font-weight: 400; }

  /* Boutons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    font-size: var(--font-base);
    font-weight: 600;
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-decoration: none;
  }

  .btn-primary {
    background-color: var(--primary);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background-color: var(--primary-dark);
    transform: translateY(-2px);
    box-shadow: var(--shadow-lg);
  }

  .btn-secondary {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }

  .btn-secondary:hover:not(:disabled) {
    background-color: var(--bg-secondary);
    border-color: var(--border-light);
  }

  .btn-success {
    background-color: var(--success);
    color: white;
  }

  .btn-success:hover:not(:disabled) {
    background-color: #3a8f3f;
  }

  .btn-danger {
    background-color: var(--danger);
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background-color: #d32f2f;
  }

  .btn-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-sm {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-sm);
  }

  .btn-lg {
    padding: var(--spacing-md) var(--spacing-lg);
    font-size: var(--font-lg);
  }

  .btn-icon {
    font-size: var(--font-lg);
  }

  .btn-text {
    display: inline-block;
  }

  /* Button Grid */
  .button-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--spacing-md);
    width: 100%;
  }

  /* Cartes */
  .card {
    background-color: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--spacing-lg);
    margin-bottom: var(--spacing-lg);
    box-shadow: var(--shadow);
    transition: transform var(--transition-normal), box-shadow var(--transition-normal);
  }

  .card:hover {
    transform: translateY(-4px);
    box-shadow: var(--shadow-lg);
  }

  .card-header {
    margin-bottom: var(--spacing-md);
    padding-bottom: var(--spacing-md);
    border-bottom: 1px solid var(--border);
  }

  .card-title {
    font-size: var(--font-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .card-body {
    color: var(--text-secondary);
  }

  .card-collapsible {
    overflow: hidden;
  }

  .card-collapsible .card-body {
    transition: max-height var(--transition-normal);
    overflow: hidden;
  }

  .card-collapsed .card-body {
    max-height: 0;
    padding: 0;
  }

  /* Formulaires */
  .form-group {
    margin-bottom: var(--spacing-lg);
  }

  .form-label {
    display: block;
    margin-bottom: var(--spacing-xs);
    font-weight: 600;
    color: var(--text-primary);
    font-size: var(--font-sm);
  }

  .form-input {
    width: 100%;
    padding: var(--spacing-sm) var(--spacing-md);
    font-size: var(--font-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--bg-secondary);
    color: var(--text-primary);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .form-input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(233, 69, 96, 0.2);
  }

  .form-input::placeholder {
    color: var(--text-muted);
  }

  /* Sliders */
  .slider-group {
    margin-bottom: var(--spacing-lg);
  }

  .slider-label {
    display: block;
    margin-bottom: var(--spacing-xs);
    font-weight: 600;
    color: var(--text-primary);
    font-size: var(--font-sm);
  }

  .slider-container {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
  }

  .slider {
    flex: 1;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--bg-tertiary);
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--primary);
    cursor: pointer;
    transition: transform var(--transition-fast);
  }

  .slider::-webkit-slider-thumb:hover {
    transform: scale(1.2);
  }

  .slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--primary);
    cursor: pointer;
    border: none;
  }

  .slider-value {
    font-size: var(--font-sm);
    color: var(--text-secondary);
    font-weight: 600;
    min-width: 60px;
    text-align: right;
  }

  /* Tableaux */
  .table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: var(--spacing-lg);
    background-color: var(--bg-card);
    border-radius: var(--radius-md);
    overflow: hidden;
    box-shadow: var(--shadow);
  }

  .table th,
  .table td {
    padding: var(--spacing-md);
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .table th {
    background-color: var(--bg-tertiary);
    font-weight: 600;
    color: var(--text-primary);
    font-size: var(--font-sm);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .table tr:hover {
    background-color: rgba(255, 255, 255, 0.05);
  }

  .table tr:last-child td {
    border-bottom: none;
  }

  /* Alertes */
  .alert {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-md);
    border-radius: var(--radius-md);
    margin-bottom: var(--spacing-md);
    animation: slideIn 0.3s ease;
  }

  .alert-error {
    background-color: rgba(244, 67, 54, 0.1);
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  .alert-success {
    background-color: rgba(76, 175, 80, 0.1);
    border: 1px solid var(--success);
    color: var(--success);
  }

  .alert-warning {
    background-color: rgba(255, 152, 0, 0.1);
    border: 1px solid var(--warning);
    color: var(--warning);
  }

  .alert-info {
    background-color: rgba(15, 52, 96, 0.1);
    border: 1px solid var(--secondary);
    color: var(--text-primary);
  }

  .alert-icon {
    font-size: var(--font-xl);
  }

  .alert-message {
    flex: 1;
    font-size: var(--font-base);
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Chargement */
  .loading-spinner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-md);
    padding: var(--spacing-xl);
  }

  .spinner {
    width: 50px;
    height: 50px;
    border: 4px solid var(--border);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  .spinner-text {
    color: var(--text-secondary);
    font-size: var(--font-base);
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Modals */
  .modal {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.8);
    z-index: var(--z-modal);
    align-items: center;
    justify-content: center;
    padding: var(--spacing-lg);
    overflow-y: auto;
  }

  .modal-content {
    background-color: var(--bg-secondary);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    width: 100%;
    max-width: 600px;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: modalIn 0.3s ease;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-lg);
    border-bottom: 1px solid var(--border);
  }

  .modal-title {
    font-size: var(--font-xl);
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: var(--font-2xl);
    cursor: pointer;
    padding: var(--spacing-xs);
    line-height: 1;
    transition: color var(--transition-fast);
  }

  .modal-close:hover {
    color: var(--text-primary);
  }

  .modal-body {
    padding: var(--spacing-lg);
    overflow-y: auto;
    flex: 1;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--spacing-md);
    padding: var(--spacing-lg);
    border-top: 1px solid var(--border);
    background-color: var(--bg-card);
  }

  @keyframes modalIn {
    from {
      opacity: 0;
      transform: translateY(-20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Tooltips */
  .tooltip {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    white-space: nowrap;
    z-index: var(--z-tooltip);
    box-shadow: var(--shadow);
    margin-bottom: var(--spacing-xs);
  }

  .tooltip::before {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: var(--bg-tertiary);
  }

  /* Sélecteurs de fichier */
  .file-input-group {
    margin-bottom: var(--spacing-lg);
  }

  .file-input-label {
    display: block;
    margin-bottom: var(--spacing-xs);
    font-weight: 600;
    color: var(--text-primary);
    font-size: var(--font-sm);
  }

  .file-input {
    display: block;
    width: 100%;
    padding: var(--spacing-md);
    border: 2px dashed var(--border);
    border-radius: var(--radius-md);
    background-color: var(--bg-secondary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .file-input:hover {
    border-color: var(--primary);
    color: var(--primary);
    background-color: var(--bg-card);
  }

  .file-input::file-selector-button {
    display: none;
  }

  /* Barre de progression */
  .progress-bar {
    width: 100%;
    height: 8px;
    background-color: var(--bg-tertiary);
    border-radius: var(--radius-full);
    overflow: hidden;
    margin-bottom: var(--spacing-sm);
  }

  .progress-fill {
    height: 100%;
    background-color: var(--primary);
    border-radius: var(--radius-full);
    transition: width var(--transition-normal);
  }

  /* Conteneurs flexibles */
  .section {
    margin-bottom: var(--spacing-xl);
  }

  .section-title {
    font-size: var(--font-xl);
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--spacing-md);
    padding-bottom: var(--spacing-sm);
    border-bottom: 1px solid var(--border);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-md);
  }

  /* Grille responsive */
  .responsive-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: var(--spacing-lg);
  }

  /* Pour mobile */
  @media (max-width: 768px) {
    .container {
      padding: 0 var(--spacing-md);
    }

    h1 { font-size: var(--font-2xl); }
    h2 { font-size: var(--font-xl); }
    h3 { font-size: var(--font-lg); }

    .button-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .modal-content {
      margin: var(--spacing-md);
      max-width: calc(100% - var(--spacing-lg));
    }

    .responsive-grid {
      grid-template-columns: 1fr;
    }

    .card {
      padding: var(--spacing-md);
    }
  }

  /* Utilitaires pour le zoom */
  .zoom-container {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: var(--spacing-lg);
  }

  .zoom-viewport {
    width: 100%;
    height: 100%;
    overflow: auto;
    background-color: var(--bg-secondary);
  }

  .zoom-content {
    position: relative;
    transform-origin: 0 0;
  }

  /* Style pour les éléments de la timeline */
  .timeline {
    position: relative;
    height: 60px;
    background-color: var(--bg-tertiary);
    border-radius: var(--radius-md);
    overflow: hidden;
    cursor: pointer;
    margin: var(--spacing-md) 0;
  }

  .timeline-fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    background-color: var(--primary);
    opacity: 0.3;
  }

  .timeline-thumb {
    position: absolute;
    top: 50%;
    left: 0;
    transform: translate(-50%, -50%);
    width: 20px;
    height: 20px;
    background-color: var(--primary);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 0 3px rgba(233, 69, 96, 0.5);
  }

  .timeline-marker {
    position: absolute;
    top: 10px;
    left: 0;
    transform: translateX(-50%);
    width: 2px;
    height: 40px;
    background-color: var(--success);
    cursor: pointer;
  }

  /* Style pour les marqueurs de frame */
  .frame-marker {
    position: absolute;
    top: 50%;
    left: 0;
    transform: translate(-50%, -50%);
    width: 12px;
    height: 12px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 0 0 2px var(--bg-primary);
    transition: all var(--transition-fast);
  }

  .frame-marker:hover {
    transform: translate(-50%, -50%) scale(1.2);
  }

  .frame-marker.landing {
    background-color: var(--success);
  }

  .frame-marker.takeoff {
    background-color: var(--warning);
  }

  .frame-marker.final-landing {
    background-color: var(--danger);
  }

  /* Style pour la zone de visualisation vidéo */
  .video-container {
    position: relative;
    background-color: var(--bg-secondary);
    border-radius: var(--radius-md);
    overflow: hidden;
    margin-bottom: var(--spacing-lg);
    box-shadow: var(--shadow);
  }

  .video-wrapper {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background-color: black;
  }

  .video-element {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .video-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-md);
    background-color: var(--bg-tertiary);
  }

  .video-info {
    display: flex;
    gap: var(--spacing-lg);
    font-size: var(--font-sm);
    color: var(--text-secondary);
  }

  /* Style pour les résultats */
  .results-panel {
    background-color: var(--bg-card);
    border-radius: var(--radius-lg);
    padding: var(--spacing-lg);
    margin-bottom: var(--spacing-lg);
    box-shadow: var(--shadow);
  }

  .results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--spacing-md);
  }

  .result-item {
    text-align: center;
    padding: var(--spacing-md);
    background-color: var(--bg-secondary);
    border-radius: var(--radius-md);
  }

  .result-label {
    display: block;
    font-size: var(--font-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: var(--spacing-xs);
  }

  .result-value {
    font-size: var(--font-xl);
    font-weight: 700;
    color: var(--primary);
  }

  .result-unit {
    font-size: var(--font-sm);
    color: var(--text-secondary);
    margin-left: var(--spacing-xs);
  }

  /* Style pour le guide */
  .guide-panel {
    background-color: var(--bg-card);
    border-radius: var(--radius-lg);
    padding: var(--spacing-lg);
    margin-bottom: var(--spacing-lg);
    box-shadow: var(--shadow);
  }

  .guide-title {
    font-size: var(--font-lg);
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--spacing-md);
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .guide-list {
    list-style: none;
  }

  .guide-list li {
    display: flex;
    align-items: flex-start;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) 0;
    border-bottom: 1px solid var(--border);
  }

  .guide-list li:last-child {
    border-bottom: none;
  }

  .guide-check {
    color: var(--success);
    font-weight: bold;
    min-width: 20px;
  }

  /* Style pour l'historique */
  .history-panel {
    background-color: var(--bg-card);
    border-radius: var(--radius-lg);
    padding: var(--spacing-lg);
    margin-bottom: var(--spacing-lg);
    box-shadow: var(--shadow);
  }

  .session-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-md);
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background-color var(--transition-fast);
  }

  .session-item:hover {
    background-color: var(--bg-secondary);
  }

  .session-item:last-child {
    border-bottom: none;
  }

  .session-name {
    font-weight: 600;
    color: var(--text-primary);
  }

  .session-date {
    color: var(--text-muted);
    font-size: var(--font-sm);
  }

  .session-stats {
    display: flex;
    gap: var(--spacing-lg);
    font-size: var(--font-sm);
    color: var(--text-secondary);
  }

  /* Style pour le graphique */
  .chart-container {
    position: relative;
    height: 300px;
    margin: var(--spacing-lg) 0;
  }

  .chart-canvas {
    width: 100%;
    height: 100%;
  }
`;

/**
 * Applique le thème à la page
 * @param theme - Thème à appliquer ('light' ou 'dark')
 */
export function applyTheme(theme: 'light' | 'dark'): void {
  const html = document.documentElement;
  
  if (theme === 'light') {
    html.classList.add('light-theme');
    html.classList.remove('dark-theme');
  } else {
    html.classList.remove('light-theme');
    html.classList.add('dark-theme');
  }
}

/**
 * Alterne entre les thèmes
 */
export function toggleTheme(): void {
  const html = document.documentElement;
  const isLight = html.classList.contains('light-theme');
  
  if (isLight) {
    applyTheme('dark');
  } else {
    applyTheme('light');
  }
}

/**
 * Obtient le thème actuel
 * @returns Thème actuel
 */
export function getCurrentTheme(): 'light' | 'dark' {
  const html = document.documentElement;
  return html.classList.contains('light-theme') ? 'light' : 'dark';
}

/**
 * Sauvegarde le thème dans localStorage
 * @param theme - Thème à sauvegarder
 */
export function saveThemePreference(theme: 'light' | 'dark'): void {
  localStorage.setItem('rsi-calc-theme', theme);
}

/**
 * Charge le thème depuis localStorage
 * @returns Thème sauvegardé ou 'dark' par défaut
 */
export function loadThemePreference(): 'light' | 'dark' {
  const saved = localStorage.getItem('rsi-calc-theme');
  return saved === 'light' ? 'light' : 'dark';
}

/**
 * Initialise le thème au chargement de la page
 */
export function initializeTheme(): void {
  const theme = loadThemePreference();
  applyTheme(theme);
}
