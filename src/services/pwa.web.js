export const initializePwa = () => {
  if (typeof window === 'undefined') return;
  // Storage permission is advisory: denial must never erase queued captures.
  navigator.storage?.persist?.().catch(() => {});
  if (!__DEV__ && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(error => {
        console.error('No se pudo habilitar el arranque offline.', error);
      });
    });
  }
};
