/**
 * Module de composants UI réutilisables
 */

/**
 * Crée un bouton avec style cohérent
 * @param text - Texte du bouton
 * @param options - Options du bouton
 * @returns Élément bouton
 */
export function createButton(
  text: string,
  options: {
    onClick?: () => void;
    className?: string;
    type?: 'primary' | 'secondary' | 'danger' | 'success';
    size?: 'small' | 'medium' | 'large';
    disabled?: boolean;
    icon?: string;
  } = {}
): HTMLButtonElement {
  const { onClick, className = '', type = 'primary', size = 'medium', disabled = false, icon } = options;

  const button = document.createElement('button');
  button.textContent = text;
  
  if (onClick) {
    button.addEventListener('click', onClick);
  }

  const baseClasses = [
    'btn',
    `btn-${type}`,
    `btn-${size}`,
    disabled ? 'btn-disabled' : '',
    className,
  ].filter(Boolean).join(' ');

  button.className = baseClasses;
  button.disabled = disabled;

  if (icon) {
    button.innerHTML = `<span class="btn-icon">${icon}</span><span class="btn-text">${text}</span>`;
  }

  return button;
}

/**
 * Crée une carte (card) pour l'interface
 * @param title - Titre de la carte
 * @param content - Contenu de la carte
 * @param options - Options
 * @returns Élément div
 */
export function createCard(
  title: string,
  content: HTMLElement | string,
  options: { className?: string; collapsible?: boolean } = {}
): HTMLDivElement {
  const { className = '', collapsible = false } = options;

  const card = document.createElement('div');
  card.className = `card ${className}`;

  const header = document.createElement('div');
  header.className = 'card-header';
  
  const titleElement = document.createElement('h3');
  titleElement.className = 'card-title';
  titleElement.textContent = title;
  header.appendChild(titleElement);

  const body = document.createElement('div');
  body.className = 'card-body';
  
  if (typeof content === 'string') {
    body.textContent = content;
  } else {
    body.appendChild(content);
  }

  card.appendChild(header);
  card.appendChild(body);

  if (collapsible) {
    card.classList.add('card-collapsible');
    header.style.cursor = 'pointer';
    
    header.addEventListener('click', () => {
      card.classList.toggle('card-collapsed');
    });
  }

  return card;
}

/**
 * Crée un input avec label
 * @param options - Options de l'input
 * @returns Conteneur avec label et input
 */
export function createInput(
  options: {
    type?: 'text' | 'number' | 'email' | 'password' | 'file';
    label: string;
    id?: string;
    value?: string | number;
    placeholder?: string;
    onChange?: (value: string | number) => void;
    onInput?: (value: string | number) => void;
    min?: number;
    max?: number;
    step?: number;
    accept?: string;
    required?: boolean;
    disabled?: boolean;
    className?: string;
  }
): HTMLDivElement {
  const {
    type = 'text',
    label,
    id = `input-${Math.random().toString(36).substring(2, 9)}`,
    value = '',
    placeholder = '',
    onChange,
    onInput,
    min,
    max,
    step,
    accept,
    required = false,
    disabled = false,
    className = '',
  } = options;

  const container = document.createElement('div');
  container.className = `form-group ${className}`;

  const labelElement = document.createElement('label');
  labelElement.htmlFor = id;
  labelElement.textContent = label;
  labelElement.className = 'form-label';

  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.value = String(value);
  input.placeholder = placeholder;
  input.className = 'form-input';
  input.required = required;
  input.disabled = disabled;

  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  if (accept) input.accept = accept;

  if (onChange) {
    input.addEventListener('change', () => {
      onChange(input.value);
    });
  }

  if (onInput) {
    input.addEventListener('input', () => {
      const numericValue = type === 'number' ? parseFloat(input.value) || 0 : input.value;
      onInput(numericValue);
    });
  }

  container.appendChild(labelElement);
  container.appendChild(input);

  return container;
}

/**
 * Crée un slider (range input)
 * @param options - Options du slider
 * @returns Conteneur avec label et slider
 */
export function createSlider(
  options: {
    label: string;
    id?: string;
    min: number;
    max: number;
    step?: number;
    value: number;
    onChange?: (value: number) => void;
    onInput?: (value: number) => void;
    unit?: string;
    className?: string;
  }
): HTMLDivElement {
  const {
    label,
    id = `slider-${Math.random().toString(36).substring(2, 9)}`,
    min,
    max,
    step = 1,
    value,
    onChange,
    onInput,
    unit = '',
    className = '',
  } = options;

  const container = document.createElement('div');
  container.className = `slider-group ${className}`;

  const labelElement = document.createElement('label');
  labelElement.htmlFor = id;
  labelElement.textContent = label;
  labelElement.className = 'slider-label';

  const sliderContainer = document.createElement('div');
  sliderContainer.className = 'slider-container';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = id;
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  slider.className = 'slider';

  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'slider-value';
  valueDisplay.textContent = `${value} ${unit}`;

  if (onChange) {
    slider.addEventListener('change', () => {
      const val = parseFloat(slider.value);
      valueDisplay.textContent = `${val} ${unit}`;
      onChange(val);
    });
  }

  if (onInput) {
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      valueDisplay.textContent = `${val} ${unit}`;
      onInput(val);
    });
  }

  sliderContainer.appendChild(slider);
  sliderContainer.appendChild(valueDisplay);

  container.appendChild(labelElement);
  container.appendChild(sliderContainer);

  return container;
}

/**
 * Crée une grille de boutons
 * @param buttons - Tableau de configurations de boutons
 * @returns Conteneur de grille
 */
export function createButtonGrid(
  buttons: Array<{
    text: string;
    onClick: () => void;
    type?: 'primary' | 'secondary' | 'danger' | 'success';
    icon?: string;
    disabled?: boolean;
  }>
): HTMLDivElement {
  const grid = document.createElement('div');
  grid.className = 'button-grid';

  buttons.forEach(button => {
    const btn = createButton(button.text, {
      onClick: button.onClick,
      type: button.type,
      disabled: button.disabled,
      icon: button.icon,
    });
    grid.appendChild(btn);
  });

  return grid;
}

/**
 * Crée un tableau de données
 * @param headers - En-têtes du tableau
 * @param rows - Lignes de données
 * @param options - Options
 * @returns Élément tableau
 */
export function createTable(
  headers: string[],
  rows: Array<Array<string | number>>,
  options: { className?: string; clickableRows?: boolean; onRowClick?: (rowIndex: number) => void } = {}
): HTMLTableElement {
  const { className = '', clickableRows = false, onRowClick } = options;

  const table = document.createElement('table');
  table.className = `table ${className}`;

  // En-tête
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  
  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header;
    headerRow.appendChild(th);
  });
  
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Corps
  const tbody = document.createElement('tbody');
  
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    
    if (clickableRows) {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => {
        if (onRowClick) onRowClick(rowIndex);
      });
    }
    
    row.forEach(cell => {
      const td = document.createElement('td');
      td.textContent = String(cell);
      tr.appendChild(td);
    });
    
    tbody.appendChild(tr);
  });
  
  table.appendChild(tbody);

  return table;
}

/**
 * Crée un message d'erreur ou de succès
 * @param message - Message à afficher
 * @param type - Type de message
 * @returns Élément message
 */
export function createAlert(
  message: string,
  type: 'error' | 'success' | 'warning' | 'info' = 'info'
): HTMLDivElement {
  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  
  // Ajouter une icône
  const iconMap: Record<string, string> = {
    error: '❌',
    success: '✅',
    warning: '⚠️',
    info: 'ℹ️',
  };
  
  alert.innerHTML = `<span class="alert-icon">${iconMap[type] || 'ℹ️'}</span><span class="alert-message">${message}</span>`;

  return alert;
}

/**
 * Crée un conteneur de chargement
 * @param message - Message à afficher
 * @returns Élément de chargement
 */
export function createLoadingSpinner(message: string = 'Chargement...'): HTMLDivElement {
  const spinner = document.createElement('div');
  spinner.className = 'loading-spinner';
  
  spinner.innerHTML = `
    <div class="spinner"></div>
    <div class="spinner-text">${message}</div>
  `;

  return spinner;
}

/**
 * Crée un sélecteur de fichier
 * @param options - Options du sélecteur
 * @returns Conteneur avec le sélecteur
 */
export function createFileInput(
  options: {
    label: string;
    accept: string;
    onChange: (file: File) => void;
    className?: string;
    multiple?: boolean;
  }
): HTMLDivElement {
  const { label, accept, onChange, className = '', multiple = false } = options;

  const container = document.createElement('div');
  container.className = `file-input-group ${className}`;

  const labelElement = document.createElement('label');
  labelElement.className = 'file-input-label';
  labelElement.textContent = label;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.className = 'file-input';

  input.addEventListener('change', (event) => {
    const files = (event.target as HTMLInputElement).files;
    if (files && files.length > 0) {
      onChange(files[0]);
      // Réinitialiser l'input pour permettre la sélection du même fichier
      input.value = '';
    }
  });

  container.appendChild(labelElement);
  container.appendChild(input);

  return container;
}

/**
 * Crée un modal
 * @param title - Titre du modal
 * @param content - Contenu du modal
 * @param options - Options
 * @returns Conteneur modal
 */
export function createModal(
  title: string,
  content: HTMLElement | string,
  options: {
    onClose?: () => void;
    closeButton?: boolean;
    footer?: HTMLElement;
  } = {}
): HTMLDivElement {
  const { onClose, closeButton = true, footer } = options;

  const modal = document.createElement('div');
  modal.className = 'modal';

  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content';

  const modalHeader = document.createElement('div');
  modalHeader.className = 'modal-header';

  const titleElement = document.createElement('h2');
  titleElement.className = 'modal-title';
  titleElement.textContent = title;

  modalHeader.appendChild(titleElement);

  if (closeButton) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.innerHTML = '✕';
    closeBtn.addEventListener('click', () => {
      if (onClose) onClose();
      document.body.removeChild(modal);
    });
    modalHeader.appendChild(closeBtn);
  }

  const modalBody = document.createElement('div');
  modalBody.className = 'modal-body';

  if (typeof content === 'string') {
    modalBody.textContent = content;
  } else {
    modalBody.appendChild(content);
  }

  modalContent.appendChild(modalHeader);
  modalContent.appendChild(modalBody);

  if (footer) {
    const modalFooter = document.createElement('div');
    modalFooter.className = 'modal-footer';
    modalFooter.appendChild(footer);
    modalContent.appendChild(modalFooter);
  }

  modal.appendChild(modalContent);

  // Fermer en cliquant en dehors
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      if (onClose) onClose();
      document.body.removeChild(modal);
    }
  });

  return modal;
}

/**
 * Affiche un modal
 * @param modal - Élément modal à afficher
 */
export function showModal(modal: HTMLDivElement): void {
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  modal.style.display = 'flex';

  // Fermer avec la touche Escape
  const closeHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      document.body.removeChild(modal);
      document.body.style.overflow = '';
      document.removeEventListener('keydown', closeHandler);
    }
  };

  document.addEventListener('keydown', closeHandler);
}

/**
 * Ferme un modal
 * @param modal - Élément modal à fermer
 */
export function closeModal(modal: HTMLDivElement): void {
  document.body.removeChild(modal);
  document.body.style.overflow = '';
}

/**
 * Crée un tooltip
 * @param text - Texte du tooltip
 * @param target - Élément cible
 * @returns Élément tooltip
 */
export function createTooltip(text: string, target: HTMLElement): HTMLDivElement {
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.textContent = text;

  target.style.position = 'relative';
  target.appendChild(tooltip);

  target.addEventListener('mouseenter', () => {
    tooltip.style.display = 'block';
  });

  target.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  return tooltip;
}
