import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider, applyDocumentLocale, resolveInitialLocale } from './i18n';
import './styles.css';

const stored = localStorage.getItem('opsweave-theme');
if (stored) document.documentElement.dataset.theme = stored;

// Set <html lang> before the first React render so the attribute is never wrong.
applyDocumentLocale(resolveInitialLocale());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
