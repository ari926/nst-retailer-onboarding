import { Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import OnboardingIndex from './pages/OnboardingIndex';
import StepPlaceholder from './pages/StepPlaceholder';
import { AppLayout } from './components/layout/AppLayout';

/**
 * App router.
 *   /                                  → public home (later: auth gate)
 *   /onboarding                        → overview / "next up" card
 *   /onboarding/profile…launch         → step forms
 *
 * Every /onboarding/* route is wrapped in AppLayout (header + sidebar).
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />

      <Route path="/onboarding" element={<AppLayout />}>
        <Route index element={<OnboardingIndex />} />
        <Route
          path="profile"
          element={
            <StepPlaceholder
              stepId={1}
              titleKey="step_1_profile.title"
              subtitleKey="step_1_profile.subtitle"
            />
          }
        />
        <Route
          path="safe"
          element={
            <StepPlaceholder
              stepId={2}
              titleKey="step_2_safe.title"
              subtitleKey="step_2_safe.subtitle"
            />
          }
        />
        <Route
          path="banking"
          element={
            <StepPlaceholder
              stepId={3}
              titleKey="step_3_banking.title"
              subtitleKey="step_3_banking.subtitle"
            />
          }
        />
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
