import React from 'react';
import ReactDOM from 'react-dom/client';
import { PopupApp } from './PopupApp';
import { ErrorBoundary } from '../sidepanel/components/ErrorBoundary';
import '../sidepanel/app.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="popup">
      <PopupApp />
    </ErrorBoundary>
  </React.StrictMode>,
);
