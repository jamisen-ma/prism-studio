import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HostedGate } from './Hosted';
import './styles.css';

createRoot(document.getElementById('root')!).render(<HostedGate><App /></HostedGate>);
