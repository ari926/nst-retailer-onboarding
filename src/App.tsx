import { Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Login from './pages/Login';
import Claim from './pages/Claim';
import OnboardingIndex from './pages/OnboardingIndex';
import StepPlaceholder from './pages/StepPlaceholder';
import Step1Profile from './pages/steps/Step1Profile';
import Step2Safe from './pages/steps/Step2Safe';
import Step3Banking from './pages/steps/Step3Banking';
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
        <Route
          path="deposit"
          element={
            <StepPlaceholder
              stepId={4}
              titleKey="step_4_deposit.title"
              subtitleKey="step_4_deposit.subtitle"
            />
          }
        />
        <Route
          path="change-order"
          element={
            <StepPlaceholder
              stepId={5}
              titleKey="step_5_change_order.title"
              subtitleKey="step_5_change_order.subtitle"
            />
          }
        />
        <Route
          path="invoicing"
          element={
            <StepPlaceholder
              stepId={6}
              titleKey="step_6_invoicing.title"
              subtitleKey="step_6_invoicing.subtitle"
            />
          }
        />
        <Route
          path="launch"
          element={
            <StepPlaceholder
              stepId={7}
              titleKey="step_7_launch.title"
              subtitleKey="step_7_launch.subtitle"
            />
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
