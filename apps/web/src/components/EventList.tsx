import { AnimatePresence, motion } from 'motion/react';
import type { AccEvent } from '../../../../packages/protocol/src/index.ts';
import { EventRow } from './EventRow.tsx';

/**
 * Liste d'événements où seuls les NOUVEAUX éléments s'animent (déploiement en hauteur + fondu),
 * avec un léger halo qui s'estompe (jamais au premier affichage). Les éléments existants glissent vers le bas sans saut.
 */
export function EventList({ events, showSession = true, compact = false }: { events: AccEvent[]; showSession?: boolean; compact?: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {events.map((e) => (
        <motion.div
          key={e.id}
          layout="position"
          initial={{ height: 0, opacity: 0, backgroundColor: 'rgba(217,119,87,0.10)' }}
          animate={{ height: 'auto', opacity: 1, backgroundColor: 'rgba(217,119,87,0)' }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ height: { type: 'spring', stiffness: 420, damping: 38 }, opacity: { duration: 0.25, ease: [0.16, 1, 0.3, 1] }, backgroundColor: { duration: 1.8, ease: 'easeOut' }, layout: { type: 'spring', stiffness: 420, damping: 38 } }}
          className="overflow-hidden"
        >
          <EventRow event={e} showSession={showSession} compact={compact} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
