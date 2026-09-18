import type { ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { canSupervise, type Action, type Resource } from '@janelle/shared';
import { useAuth } from './context/AuthContext';
import { AppShell } from './components/AppShell';
import { AssistantProvider } from './context/AssistantContext';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Vendors from './pages/Vendors';
import Prompts from './pages/Prompts';
import FollowUps from './pages/FollowUps';
import Tasks from './pages/Tasks';
import Assistant from './pages/Assistant';
import Team from './pages/Team';
import Permissions from './pages/Permissions';
import Drafts from './pages/Drafts';
import Reports from './pages/Reports';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import Login from './pages/Login';
import ConfigNeeded from './pages/ConfigNeeded';
import UsageReport from './pages/UsageReport';
import { Inbox, Documents } from './pages/Simple';

function FullScreen({ label }: { label: string }) {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="text-[13px] font-medium text-ink-faint">{label}</div>
    </div>
  );
}

function BackendError({ message, onRetry, onSignOut }: { message: string; onRetry: () => void; onSignOut: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="card w-full max-w-md p-7">
        <span className="text-[12px] font-semibold text-crit">Can’t reach the server</span>
        <h1 className="mt-2 text-2xl font-semibold text-ink">The API isn’t responding</h1>
        <p className="mt-2 text-[14px] text-ink-soft">
          You’re signed in, but the app couldn’t load your profile. Make sure the API server is running
          and that <span className="text-[12.5px]">VITE_API_BASE_URL</span> matches its port.
        </p>
        <p className="mt-3 rounded-lg bg-sunk px-3 py-2 text-[11.5px] text-ink-soft">{message}</p>
        <div className="mt-5 flex gap-2">
          <button onClick={onRetry} className="btn-primary">Retry</button>
          <button onClick={onSignOut} className="btn-secondary">Sign out</button>
        </div>
      </div>
    </div>
  );
}

/**
 * A page the studio has closed to this role.
 *
 * The sidebar already hides these, but a bookmark, a link in a digest or a
 * typed URL still lands here — and without this the page rendered and every
 * query behind it came back 403, which reads as "the system is broken"
 * rather than "this is not yours to see".
 */
function Viewable({
  needs,
  action = 'read',
  supervisorOnly,
  principalOnly,
  children,
}: {
  needs?: Resource;
  /** 'update' for the administration screens — see NavItem.needsWrite. */
  action?: Action;
  supervisorOnly?: boolean;
  /** Permissions only: the module that grants the others is not grantable. */
  principalOnly?: boolean;
  children: ReactNode;
}) {
  const { may, user } = useAuth();
  const allowed =
    (!needs || may(needs, action)) &&
    (!supervisorOnly || canSupervise(user?.role ?? null)) &&
    (!principalOnly || user?.role === 'principal');
  if (allowed) return <>{children}</>;
  return (
    <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
      This part of the studio is not open to your role. Ask a principal if you need it.
    </div>
  );
}

export default function App() {
  const { configured, loading, session, user, profileError, refresh, signOut } = useAuth();
  const { pathname } = useLocation();

  // The shared AI usage report is reachable by its link alone: no sidebar,
  // no sign-in, and no wait on the session — whoever holds the URL is not
  // expected to have an account here.
  if (pathname.startsWith('/u/')) {
    return (
      <Routes>
        <Route path="/u/:token" element={<UsageReport />} />
      </Routes>
    );
  }

  if (!configured) return <ConfigNeeded />;
  if (loading) return <FullScreen label="Loading…" />;
  if (!session) return <Login />;
  // Signed in but no profile: either provisioning, or the API is unreachable.
  if (!user) {
    if (profileError) return <BackendError message={profileError} onRetry={refresh} onSignOut={signOut} />;
    return <FullScreen label="Setting up your studio…" />;
  }

  return (
    // Above the pages, so the conversation outlives any one of them.
    <AssistantProvider>
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Viewable needs="projects"><Projects /></Viewable>} />
        <Route path="/projects/:id" element={<Viewable needs="projects"><ProjectDetail /></Viewable>} />
        <Route path="/vendors" element={<Viewable needs="vendors"><Vendors /></Viewable>} />
        <Route path="/inbox" element={<Viewable needs="emails"><Inbox /></Viewable>} />
        <Route path="/documents" element={<Viewable needs="documents"><Documents /></Viewable>} />
        <Route path="/prompts" element={<Viewable needs="prompts"><Prompts /></Viewable>} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/tasks" element={<Viewable needs="tasks"><Tasks /></Viewable>} />
        <Route path="/follow-ups" element={<Viewable needs="follow_ups"><FollowUps /></Viewable>} />
        <Route path="/drafts" element={<Viewable needs="drafts"><Drafts /></Viewable>} />
        <Route path="/reports" element={<Viewable needs="reports"><Reports /></Viewable>} />
        <Route path="/activity" element={<Viewable supervisorOnly><Activity /></Viewable>} />
        <Route path="/team" element={<Viewable needs="team" action="update"><Team /></Viewable>} />
        <Route path="/permissions" element={<Viewable principalOnly><Permissions /></Viewable>} />
        <Route path="/settings" element={<Viewable needs="settings"><Settings /></Viewable>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
    </AssistantProvider>
  );
}
