import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { getDefaultTerminalFontFamily } from './lib/platform';

if (typeof document !== 'undefined') {
  document.documentElement.style.setProperty('--font-terminal', getDefaultTerminalFontFamily());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
