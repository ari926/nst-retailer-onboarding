import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { LockedBanner } from './LockedBanner';
import { AdminModeBanner } from './AdminModeBanner';
import { DemoModeBanner } from './DemoModeBanner';
import { useOnboardingStore } from '../../stores/onboardingStore';

/**
 * Two-column shell used by the /onboarding/* routes.
 *
 * Layout order:
 *   AdminModeBanner (only visible when source = 'admin_access')
 *   Header
 *   Sidebar | LockedBanner + step content (via <Outlet/>)
 */
export function AppLayout() {
  const locked = useOnboardingStore((s) => s.locked);

  return (
    <div className="app-shell">
      <DemoModeBanner />
      <AdminModeBanner />
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
