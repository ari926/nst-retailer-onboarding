import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { LockedBanner } from './LockedBanner';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { STEPS } from '../../types/onboarding';

/**
 * Two-column shell used by the /onboarding/* routes.
 * Left rail: step navigation sidebar.
 * Right rail: header + locked banner + step content (via <Outlet/>).
 */
export function AppLayout() {
  const locked = useOnboardingStore((s) => s.locked);
  const completedSteps = useOnboardingStore((s) => s.completedSteps);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);
  const { pathname } = useLocation();

  // Once every step is complete, the org is provisioned and the "setup mode"
  // banner becomes misleading. Hide it on the completion screen.
  const allDone = STEPS.every((s) => completedSteps.includes(s.id));

  // Keep `currentStep` in sync with the URL. Without this, navigating via the
  // sidebar, browser back/forward, or a direct link leaves the header progress
  // bar and sidebar status stuck on whatever the last submit handler set.
  useEffect(() => {
    const match = STEPS.find((s) => s.path === pathname);
    if (match) setCurrentStep(match.id);
  }, [pathname, setCurrentStep]);

  // Scroll the main content back to the top on every route change so the next
  // step starts from its header rather than wherever the user left off in the
  // previous step (the page is sticky-scrolled, not scroll-restored by RR).
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'auto' });
  }, [pathname]);

  return (
    <div className="app-shell">
      <Header />
      <div className="app-body">
        <Sidebar />
        <main className="app-main" id="main-content" tabIndex={-1}>
          <div className="app-main__inner">
            {locked && !allDone && <LockedBanner />}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
