import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider, applyDocumentLocale, resolveInitialLocale } from './i18n';
import { applyDocumentTheme, resolveInitialTheme } from './shells/surface/SurfaceChrome';
import './styles.css';

// Before the first paint, and from the same rule the toggle uses: a persisted choice wins,
// otherwise the OS preference does. V5 only read localStorage, so every visitor whose system
// asked for dark still got a light console.
applyDocumentTheme(resolveInitialTheme());

// Set <html lang> before the first React render so the attribute is never wrong.
applyDocumentLocale(resolveInitialLocale());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
