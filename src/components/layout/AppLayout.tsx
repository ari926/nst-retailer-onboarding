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
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);
  const { pathname } = useLocation();

  // Keep `currentStep` in sync with the URL. Without this, navigating via the
  // sidebar, browser back/forward, or a direct link leaves the header progress
  // bar and sidebar status stuck on whatever the last submit handler set.
  useEffect(() => {
    const match = STEPS.find((s) => s.path === pathname);
    if (match) setCurrentStep(match.id);
  }, [pathname, setCurrentStep]);

  return (
    <div className="app-shell">
      <Header />
      <div className="app-body">
        <Sidebar />
        <main className="app-main" id="main-content" tabIndex={-1}>
          <div className="app-main__inner">
            {locked && <LockedBanner />}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
