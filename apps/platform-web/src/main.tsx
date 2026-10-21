import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const stored = localStorage.getItem('opsweave-theme');
if (stored) document.documentElement.dataset.theme = stored;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
