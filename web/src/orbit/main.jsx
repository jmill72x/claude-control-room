import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../components/ErrorBoundary.jsx';
import { OrbitApp } from './OrbitApp.jsx';
import './orbit.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <OrbitApp />
    </ErrorBoundary>
  </StrictMode>
);
