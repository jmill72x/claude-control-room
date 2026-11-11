import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../components/ErrorBoundary.jsx';
import { OrbitApp } from './OrbitApp.jsx';
import './orbit.css';
import { registerWorker, resync } from './pushApi.js';
import { watchBuild } from './buildWatch.js';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <OrbitApp />
    </ErrorBoundary>
  </StrictMode>
);

// Web Push (the chat's notifications): the worker, and this device's subscription
// sent again on each launch once notifications were turned on here.
registerWorker();
resync();

// A new build reloads the page once it's safe (the home-screen app otherwise
// keeps the old one until it's swiped away).
watchBuild();
