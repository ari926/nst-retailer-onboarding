import { Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Login from './pages/Login';
import Claim from './pages/Claim';
import OnboardingIndex from './pages/OnboardingIndex';
import OnboardingStart from './pages/OnboardingStart';
import Step1Profile from './pages/steps/Step1Profile';
import Step2Safe from './pages/steps/Step2Safe';
import Step4Deposit from './pages/steps/Step4Deposit';
import Step5ChangeOrder from './pages/steps/Step5ChangeOrder';
import Step6Invoicing from './pages/steps/Step6Invoicing';
import Step7FirstPickup from './pages/steps/Step7FirstPickup';
import { AppLayout } from './components/layout/AppLayout';
import { ProtectedRoute } from './components/auth/ProtectedRoute';

/**
 * App router (V2 — 6 steps, banking removed).
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
 * Step numbering (after V2 banking removal):
 *   1. profile      → Step1Profile
 *   2. safe         → Step2Safe
 *   3. deposit      → Step4Deposit  (filename retained, stepId is 3)
 *   4. change-order → Step5ChangeOrder (stepId 4)
 *   5. invoicing    → Step6Invoicing (stepId 5)
 *   6. launch       → Step7FirstPickup (stepId 6)
 *
 * The legacy /onboarding/banking route 301s to /onboarding/deposit so any
 * stale magic-link emails or in-flight drafts don't 404.
 */
export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/claim" element={<Claim />} />
      <Route path="/onboarding/start" element={<OnboardingStart />} />

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
        <Route
          path="banking"
          element={<Navigate to="/onboarding/deposit" replace />}
        />
        <Route path="deposit" element={<Step4Deposit />} />
        <Route path="change-order" element={<Step5ChangeOrder />} />
        <Route path="invoicing" element={<Step6Invoicing />} />
        <Route path="launch" element={<Step7FirstPickup />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
