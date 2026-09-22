import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if (typeof document !== 'undefined') {
  const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);
  document.documentElement.style.setProperty(
    '--font-terminal',
    isWindows
      ? "'Cascadia Mono', Consolas, 'Microsoft YaHei', monospace"
      : "Menlo, Monaco, 'PingFang SC', monospace"
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
