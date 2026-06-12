import { useAuth, signOut } from '../../hooks/useAuth';
import { useTranslation } from 'react-i18next';

/**
 * AdminModeBanner — surfaces above every onboarding page when the active
 * session is an HQ admin "view as customer" token (source = 'admin_access').
 *
 * Customers never see this. Admins see who they are, who they're viewing,
 * and have a one-click exit. Every action they take while this banner is
 * up is tagged in the audit log as admin-initiated.
 */
export function AdminModeBanner() {
  const { isAdminSession, tokenSession } = useAuth();
  const { t } = useTranslation();

  if (!isAdminSession || !tokenSession) return null;

  const adminEmail = tokenSession.acting_admin_email ?? 'unknown@talaria.com';
  const expiresAt = new Date(tokenSession.expires_at);
  const hoursLeft = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 3_600_000));

  const handleExit = async () => {
    await signOut();
    // Close the tab if possible; otherwise redirect home.
    if (window.opener) {
      window.close();
    } else {
      window.location.href = '/';
    }
  };

  return (
    <div
      role="alert"
      style={{
        background: '#FEF3C7',
        borderBottom: '1px solid #F59E0B',
        color: '#78350F',
        padding: 'var(--space-3) var(--space-6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-4)',
        fontSize: '0.875rem',
        fontWeight: 500,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span aria-hidden style={{ fontSize: '1rem' }}>🔧</span>
        <span>
          {t(
            'admin_banner.text',
            'Admin mode — {adminEmail} viewing customer portal. All actions are logged. Session expires in {hours}h.',
            { adminEmail, hours: hoursLeft },
          )}
        </span>
      </div>
      <button
        type="button"
        onClick={handleExit}
        className="btn btn-sm"
        style={{
          background: '#78350F',
          color: '#FEF3C7',
          border: 'none',
          padding: 'var(--space-1) var(--space-3)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          fontWeight: 600,
          fontSize: '0.8125rem',
          whiteSpace: 'nowrap',
        }}
      >
        {t('admin_banner.exit', 'Exit admin mode')}
      </button>
    </div>
  );
}
