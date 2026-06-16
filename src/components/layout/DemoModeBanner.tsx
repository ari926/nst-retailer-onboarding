import { isDemoMode } from '../../lib/demoMode';

/**
 * DemoModeBanner — surfaces above every onboarding page when the visitor
 * has `?demo=1` in their URL (persisted in sessionStorage).
 *
 * In demo mode all step fields are pre-filled with valid placeholder data
 * and no backend writes happen. The banner makes that obvious so testers
 * don't think they're working with real customer data.
 */
export function DemoModeBanner() {
  if (!isDemoMode()) return null;

  return (
    <div
      role="alert"
      style={{
        background: '#DBEAFE',
        borderBottom: '1px solid #2563EB',
        color: '#1E3A8A',
        padding: 'var(--space-3) var(--space-6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-2)',
        fontSize: '0.875rem',
        fontWeight: 600,
        textAlign: 'center',
      }}
    >
      <span>
        DEMO MODE — all fields are pre-filled with sample data. Click through to preview every screen. Nothing you do here is saved or sent.
      </span>
    </div>
  );
}
