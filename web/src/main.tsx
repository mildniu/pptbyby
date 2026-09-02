import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import './index.css';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import CreatePage from './pages/CreatePage';
import TaskPage from './pages/TaskPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminTasksPage from './pages/AdminTasksPage';
import { useApp } from './stores/app';

function Guard({ children }: { children: React.ReactNode }) {
  const authed = useApp((s) => s.authed);
  const checkAuth = useApp((s) => s.checkAuth);

  React.useEffect(() => {
    if (authed === null) checkAuth();
  }, [authed, checkAuth]);

  if (authed === null) {
    return <div className="flex h-screen items-center justify-center text-sm text-neutral-400">加载中…</div>;
  }
  if (!authed) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const user = useApp((s) => s.user);
  if (user && user.role !== 'admin') return <Navigate to="/create" replace />;
  return <>{children}</>;
}

window.addEventListener('auth:expired', () => useApp.getState().setAuthed(false));

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <Guard>
        <Layout />
      </Guard>
    ),
    children: [
      { index: true, element: <Navigate to="/create" replace /> },
      { path: 'create', element: <CreatePage /> },
      { path: 'task/:id', element: <TaskPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'admin/users', element: <AdminGuard><AdminUsersPage /></AdminGuard> },
      { path: 'admin/tasks', element: <AdminGuard><AdminTasksPage /></AdminGuard> },
    ],
  },
  { path: '*', element: <Navigate to="/create" replace /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
