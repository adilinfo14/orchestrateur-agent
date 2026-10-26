import { lazy, Suspense, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
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
    <DialogProvider>
      <Shell user={user}>
        <Suspense fallback={<div className="h-full grid place-items-center text-faint"><Spinner /></div>}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/graph" element={<Graph />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="/orchestrate" element={<Orchestrate />} />
            <Route path="/machines" element={<Machines />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </Suspense>
      </Shell>
    </DialogProvider>
  );
}
