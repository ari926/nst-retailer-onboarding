import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { ProtectedRoute } from './components/auth/ProtectedRoute';

/**
 * App router.
 *
 *   Public:
 *     /                 → marketing landing
 *     /login            → returning user sign-in
 *     /claim            → Step 0: new retailer claims account
 *
 *   Protected (require auth):
 *     /onboarding       → overview / "next up"
 *     /onboarding/*     → step forms
 *
 * Step pages are lazy-loaded so the initial bundle only ships the
 * landing + auth code. jsPDF/html2canvas ride along on the /onboarding
 * index chunk, which is itself lazy, so public visitors never download
 * ~350KB of PDF tooling.
 */

const Home = lazy(() => import('./pages/Home'));
const Login = lazy(() => import('./pages/Login'));
const Claim = lazy(() => import('./pages/Claim'));
const OnboardingIndex = lazy(() => import('./pages/OnboardingIndex'));
const Step1Profile = lazy(() => import('./pages/steps/Step1Profile'));
const Step2Safe = lazy(() => import('./pages/steps/Step2Safe'));
const Step3Banking = lazy(() => import('./pages/steps/Step3Banking'));
const Step4Deposit = lazy(() => import('./pages/steps/Step4Deposit'));
const Step5ChangeOrder = lazy(() => import('./pages/steps/Step5ChangeOrder'));
const Step6Invoicing = lazy(() => import('./pages/steps/Step6Invoicing'));
const Step7FirstPickup = lazy(() => import('./pages/steps/Step7FirstPickup'));

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '50vh',
        color: 'var(--color-text-muted)',
        fontSize: 'var(--text-sm)',
      }}
    >
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public */}
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/claim" element={<Claim />} />

        {/* Protected */}
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<OnboardingIndex />} />
          <Route path="profile" element={<Step1Profile />} />
          <Route path="safe" element={<Step2Safe />} />
          <Route path="banking" element={<Step3Banking />} />
          <Route path="deposit" element={<Step4Deposit />} />
          <Route path="change-order" element={<Step5ChangeOrder />} />
          <Route path="invoicing" element={<Step6Invoicing />} />
          <Route path="launch" element={<Step7FirstPickup />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
