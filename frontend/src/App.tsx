import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AdminLayout, DashboardLayout, PublicLayout } from './components/layouts';
import { ErrorBoundary, Spinner } from './components/ui';

const L = (loader: () => Promise<{ default: React.ComponentType }>) => lazy(loader);
const Landing = L(() => import('./pages/public/Landing'));
const Info = L(() => import('./pages/public/Info'));
const Auth = L(() => import('./pages/public/Auth'));
const Dashboard = L(() => import('./pages/dashboard'));
const Admin = L(() => import('./pages/admin'));

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="page"><Spinner /></div>}>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route index element={<Landing />} />
            <Route path="*" element={<Info />} />
            <Route path="login/*" element={<Auth />} />
            <Route path="register" element={<Auth />} />
            <Route path="verify-email" element={<Auth />} />
            <Route path="forgot-password" element={<Auth />} />
            <Route path="reset-password" element={<Auth />} />
            <Route path="accept-invitation" element={<Auth />} />
            <Route path="confirm-forwarding" element={<Auth />} />
          </Route>
          <Route path="dashboard/*" element={<DashboardLayoutRoutes />} />
          <Route path="admin/*" element={<AdminLayoutRoutes />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

function DashboardLayoutRoutes() {
  return <Routes><Route element={<DashboardLayout />}><Route path="*" element={<Dashboard />} /></Route></Routes>;
}
function AdminLayoutRoutes() {
  return <Routes><Route element={<AdminLayout />}><Route path="*" element={<Admin />} /></Route></Routes>;
}
