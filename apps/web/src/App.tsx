import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, logout, tryRefresh } from './api';
import { homeFor, SessionContext, type Me } from './session';
import { Login } from './pages/Login';
import { StudentHome } from './pages/StudentHome';
import { TaskPage } from './pages/TaskPage';
import { Mentor } from './pages/Mentor';
import { Events, OrganiserQr } from './pages/Events';
import { TeacherHome } from './pages/TeacherHome';
import { CreateTask } from './pages/CreateTask';
import { Review } from './pages/Review';
import { TemplateDetail } from './pages/TemplateDetail';
import { StudentProfile } from './pages/StudentProfile';
import { ParentHome } from './pages/ParentHome';
import { AdminHome } from './pages/AdminHome';
import { Evidence } from './pages/Evidence';

const NAV: Record<string, [string, string][]> = {
  student: [['/', 'Today'], ['/mentor', 'AI Mentor'], ['/events', 'Events'], ['/evidence', 'Portfolio']],
  teacher: [['/', 'My Students'], ['/review', 'Review'], ['/tasks/new', 'New task'], ['/events', 'Events']],
  admin: [['/', 'Institution'], ['/teacher', 'Students'], ['/review', 'Review'], ['/tasks/new', 'New task'], ['/events', 'Events']],
  parent: [['/', 'My Child']],
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);

  const reload = useCallback(async () => { setMe(await api<Me>('/auth/me')); }, []);
  useEffect(() => {
    // Restore a session from the refresh cookie, if any.
    tryRefresh().then((ok) => (ok ? reload() : undefined)).catch(() => undefined).finally(() => setBooting(false));
  }, [reload]);

  if (booting) return <div className="login muted">Loading…</div>;
  if (!me) return <Login onLoggedIn={reload} />;

  const home = homeFor(me);
  const signOut = async () => { await logout(); setMe(null); };
  return (
    <SessionContext.Provider value={{ me, reload, signOut }}>
      <header className="topbar">
        <div className="inner">
          <div className="brand">Student<span>360</span></div>
          <nav className="nav">
            {NAV[home]!.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
          </nav>
          <span className="tiny who" title={me.tenant.name}>{me.user.full_name}</span>
          <button className="btn ghost sm" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="shell" style={{ paddingTop: 16 }}>
        <Routes>
          <Route path="/" element={home === 'student' ? <StudentHome /> : home === 'parent' ? <ParentHome /> : home === 'admin' ? <AdminHome /> : <TeacherHome />} />
          <Route path="/teacher" element={<TeacherHome />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/tasks/new" element={<CreateTask />} />
          <Route path="/templates/:id" element={<TemplateDetail />} />
          <Route path="/review" element={<Review />} />
          <Route path="/students/:id" element={<StudentProfile />} />
          <Route path="/mentor" element={<Mentor />} />
          <Route path="/events" element={<Events />} />
          <Route path="/events/sessions/:id/qr" element={<OrganiserQr />} />
          <Route path="/evidence" element={<Evidence />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </SessionContext.Provider>
  );
}
