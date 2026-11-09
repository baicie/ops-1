import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, applyDocumentLocale, resolveInitialLocale } from '@opsweave/platform-client/i18n';
import { applyDocumentTheme, resolveInitialTheme } from '@opsweave/ui/surface-chrome';
import { App } from './App';
import '@opsweave/ui/styles';

// Before the first paint, from the same rule the toggle uses.
applyDocumentTheme(resolveInitialTheme());
applyDocumentLocale(resolveInitialLocale());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
