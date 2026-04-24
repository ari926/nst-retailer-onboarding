import { Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Login from './pages/Login';
import Claim from './pages/Claim';
import OnboardingIndex from './pages/OnboardingIndex';
import Step1Profile from './pages/steps/Step1Profile';
import Step2Safe from './pages/steps/Step2Safe';
import Step3Banking from './pages/steps/Step3Banking';
import Step4Deposit from './pages/steps/Step4Deposit';
import Step5ChangeOrder from './pages/steps/Step5ChangeOrder';
import Step6Invoicing from './pages/steps/Step6Invoicing';
import Step7FirstPickup from './pages/steps/Step7FirstPickup';
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
 *     /onboarding/*     → step forms (placeholders until PR #4-#9)
 */
export default function App() {
  return (
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
  );
}
