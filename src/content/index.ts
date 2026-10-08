/**
 * Content-script bootstrap: observe YouTube's SPA DOM, and when video
 * cards appear, swap their thumbnails for real storyboards frames.
 */

import { SpatObserver } from './observer';
import { ThumbnailSwapper } from './thumb-swapper';
import { loadSettings, type NobaitSettings } from './settings';
import '../styles/base.css';

console.info('[nobait] content script loaded');

async function main(): Promise<void> {
  const settings: NobaitSettings = await loadSettings();

  const swapper = new ThumbnailSwapper({
    position: settings.thumbnailPosition,
    onDone: (id) => {
      if (settings.debug) console.debug('[nobait] thumbnail swapped:', id);
    },
  });

  const observer = new SpatObserver({
    onCards: (cards) => {
      void swapper.applyCards(cards);
    },
  });

  observer.start();
  observer.initialScan();

  // Diagnostics hook (see AGENTS.md debugging tips).
  window.addEventListener('nobait:debug', () => {
    console.debug('[nobait] settings:', settings);
  });

  window.addEventListener('pagehide', () => {
    observer.stop();
    swapper.dispose();
  });
}

void main();
