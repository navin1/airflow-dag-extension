import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import BatchOptimizerPage from './BatchOptimizerPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BatchOptimizerPage />
  </StrictMode>,
);
