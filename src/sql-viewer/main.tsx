import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import SqlViewerPage from './SqlViewerPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SqlViewerPage />
  </StrictMode>,
);
