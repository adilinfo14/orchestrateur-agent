import type { Transition } from 'motion/react';

// Courbes et ressorts partagés : mêmes sensations dans toute l'interface.
export const spring: Transition = { type: 'spring', stiffness: 520, damping: 42, mass: 0.8 };
export const springSoft: Transition = { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 };
export const springSnappy: Transition = { type: 'spring', stiffness: 700, damping: 45 };
export const easeOut: Transition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] };
export const easeOutSlow: Transition = { duration: 0.42, ease: [0.16, 1, 0.3, 1] };
