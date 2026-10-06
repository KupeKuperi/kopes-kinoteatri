// First: in a phone's browser this provides window.mb (the desktop window gets it from its preload).
import './lib/web-bridge';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
