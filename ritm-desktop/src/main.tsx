import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { I18nProvider } from './i18n';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);

// Service worker hanya untuk Player Web (browser), bukan di dalam Electron.
const inElectron = !!(globalThis as { ritmDesktop?: unknown }).ritmDesktop;
if ('serviceWorker' in navigator && !inElectron && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[sw]', err));
  });
}
