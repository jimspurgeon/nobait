/**
 * Simple hover tooltip (pure CSS/JS, no framework)
 */

export interface TooltipOptions {
  maxWidth?: number;
  offsetX?: number;
  offsetY?: number;
}

/**
 * Create a tooltip element that appears on hover
 */
export function createTooltip(text: string, options: TooltipOptions = {}): HTMLElement {
  const { maxWidth = 300, offsetX = 5, offsetY = 5 } = options;

  const tooltip = document.createElement('div');
  tooltip.className = 'nobait-tooltip';
  tooltip.style.cssText = `
    position: absolute;
    max-width: ${maxWidth}px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.9);
    color: #fff;
    font-size: 13px;
    line-height: 1.4;
    border-radius: 4px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease-in-out;
    z-index: 10000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    white-space: normal;
    text-align: left;
    margin-top: ${offsetY}px;
    margin-left: ${offsetX}px;
  `;
  tooltip.textContent = text;

  return tooltip;
}

/**
 * Attach tooltip to a host element
 */
export function attachTooltip(host: HTMLElement, text: string, options: TooltipOptions = {}): void {
  const tooltip = createTooltip(text, options);
  document.body.appendChild(tooltip);

  const show = (_e: MouseEvent) => {
    const rect = host.getBoundingClientRect();
    const { offsetX = 5, offsetY = 5 } = options;
    tooltip.style.left = `${rect.right + offsetX}px`;
    tooltip.style.top = `${rect.top + offsetY}px`;
    tooltip.style.opacity = '1';
  };

  const hide = () => {
    tooltip.style.opacity = '0';
  };

  host.addEventListener('mouseenter', show);
  host.addEventListener('mouseleave', hide);

  // Cleanup function
  host._nobaitTooltipCleanup = () => {
    host.removeEventListener('mouseenter', show);
    host.removeEventListener('mouseleave', hide);
    tooltip.remove();
  };
}

// Extend HTMLElement interface
declare global {
  interface HTMLElement {
    _nobaitTooltipCleanup?: () => void;
  }
}
