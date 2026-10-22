'use client';

import { createContext, useContext } from 'react';

// PS-PhilGEPS status + last Sync data, provided by app/ps-philgeps/layout.js to its pages
export const PsContext = createContext(null);
export const usePsPhilgeps = () => useContext(PsContext);
