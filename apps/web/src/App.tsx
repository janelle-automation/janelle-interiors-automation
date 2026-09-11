import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { AppShell } from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Vendors from './pages/Vendors';
import Prompts from './pages/Prompts';
import FollowUps from './pages/FollowUps';
import Tasks from './pages/Tasks';
import Assistant from './pages/Assistant';
import Drafts from './pages/Drafts';
import Reports from './pages/Reports';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import Login from './pages/Login';
import ConfigNeeded from './pages/ConfigNeeded';
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

export default function App() {
  const { configured, loading, session, user, profileError, refresh, signOut } = useAuth();

  if (!configured) return <ConfigNeeded />;
  if (loading) return <FullScreen label="Loading…" />;
  if (!session) return <Login />;
  // Signed in but no profile: either provisioning, or the API is unreachable.
  if (!user) {
    if (profileError) return <BackendError message={profileError} onRetry={refresh} onSignOut={signOut} />;
    return <FullScreen label="Setting up your studio…" />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/vendors" element={<Vendors />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/prompts" element={<Prompts />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/follow-ups" element={<FollowUps />} />
        <Route path="/drafts" element={<Drafts />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
