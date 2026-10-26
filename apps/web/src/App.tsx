import { lazy, Suspense, useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { api } from './lib/api.ts';
import { startLive } from './lib/live.ts';
import { Shell } from './components/Shell.tsx';
import { DialogProvider } from './components/dialogs.tsx';
import { Spinner } from './components/ui.tsx';
import { Login } from './pages/Login.tsx';
import { Overview } from './pages/Overview.tsx';
import { SessionDetail } from './pages/SessionDetail.tsx';
import { Timeline } from './pages/Timeline.tsx';
import { Machines } from './pages/Machines.tsx';
import { Audit } from './pages/Audit.tsx';
import { Orchestrate } from './pages/Orchestrate.tsx';

// React Flow est chargé à la demande : la vue d'ensemble reste légère sur iPhone.
const Graph = lazy(() => import('./pages/Graph.tsx'));

/** Transition de page : fondu et léger glissement, sans bloquer l'affichage de la page suivante. */
function AnimatedRoutes() {
  const location = useLocation();
  // Les sous-pages d'une même section ne rejouent pas la transition.
  const key = location.pathname.split('/')[1] || 'home';
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={key}
        className="h-full"
        initial={{ opacity: 0, y: 6, filter: 'blur(2px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
      >
        <Routes location={location}>
          <Route path="/" element={<Overview />} />
          <Route path="/graph" element={<Graph />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/timeline" element={<Timeline />} />
          <Route path="/orchestrate" element={<Orchestrate />} />
          <Route path="/machines" element={<Machines />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="*" element={<Overview />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    api<{ username: string | null }>('/api/me').then((r) => setUser(r.username), () => setUser(null));
    const onUnauth = () => setUser(null);
    window.addEventListener('acc:unauthorized', onUnauth);
    return () => window.removeEventListener('acc:unauthorized', onUnauth);
  }, []);

  useEffect(() => { if (user) startLive(); }, [user]);

  if (user === undefined) return <div className="h-full grid place-items-center text-faint"><Spinner /></div>;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <MotionConfig reducedMotion="user">
    <DialogProvider>
      <Shell user={user}>
        <Suspense fallback={<div className="h-full grid place-items-center text-faint"><Spinner /></div>}>
          <AnimatedRoutes />
        </Suspense>
      </Shell>
    </DialogProvider>
    </MotionConfig>
  );
}
