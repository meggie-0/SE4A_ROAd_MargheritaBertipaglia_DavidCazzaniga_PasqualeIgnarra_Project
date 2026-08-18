import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyTheme, loadTheme } from './theme';
import './styles.css';

applyTheme(loadTheme());

const container = document.getElementById('root');
if (!container) {
  throw new Error('Elemento #root assente in index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
