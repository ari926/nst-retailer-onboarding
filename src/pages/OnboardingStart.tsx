import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  resolveOnboardingToken,
  signInFromPrefill,
} from '../lib/onboardingToken';

/**
 * /onboarding/start?token=XYZ
 *
 * Lands here from the kickoff email's "Start onboarding" CTA. We:
 *   1. Read the token from the URL.
 *   2. Call resolve-onboarding-token to fetch the live SFDC prefill bundle.
 *   3. Persist the bundle to localStorage (consumed by Step1/2/3 defaults).
 *   4. Mock-sign-in the recipient so ProtectedRoute passes.
 *   5. Redirect to /onboarding/profile.
 *
 * If the token is invalid or the resolve call fails, show a friendly error
 * with a link back to /claim so the retailer can fall back to manual claim.
 */
export default function OnboardingStart() {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      // Hash routing: HashRouter strips the hash, so search params live on
      // location.search OR (older browsers) on the hash itself.
      const fromSearch = new URLSearchParams(location.search).get('token');
      const fromHash = (() => {
        const h = window.location.hash || '';
        const idx = h.indexOf('?');
        if (idx === -1) return null;
        return new URLSearchParams(h.slice(idx + 1)).get('token');
      })();
      const token = fromSearch || fromHash;

      if (!token) {
        setError(
          "We couldn't find an onboarding token in this link. Try the link from your email again, or claim your account manually.",
        );
        return;
      }

      try {
        const result = await resolveOnboardingToken(token);
        const sfdcAccountId =
          result.sfdc_account_id ||
          result.prefill?.account?.sfdc_id ||
          null;

        if (!result.prefill || !sfdcAccountId) {
          throw new Error('No account found for this token.');
        }

        signInFromPrefill(result.prefill, sfdcAccountId);
        navigate('/onboarding/profile', { replace: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(
          msg.includes('invalid') || msg.includes('revoked')
            ? "This link has expired or already been used. Sign in to continue, or contact your NST rep for a fresh link."
            : `We hit a snag loading your onboarding: ${msg}`,
        );
      }
    })();
  }, [navigate, location.search]);

  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          background: '#FAFAF7',
        }}
      >
        <div
          style={{
            maxWidth: 480,
            padding: '32px',
            background: '#fff',
            border: '1px solid #E5E2DA',
            borderRadius: 12,
            boxShadow: '0 4px 12px rgba(40, 37, 29, 0.06)',
          }}
        >
          <h2 style={{ marginTop: 0, color: '#28251D' }}>
            Hmm, that link didn't work
          </h2>
          <p style={{ color: '#7A7974', lineHeight: 1.5 }}>{error}</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <a
              href="#/login"
              style={{
                padding: '10px 16px',
                background: '#01696F',
                color: '#fff',
                borderRadius: 8,
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              Sign in
            </a>
            <a
              href="#/claim"
              style={{
                padding: '10px 16px',
                color: '#01696F',
                borderRadius: 8,
                textDecoration: 'none',
                fontWeight: 600,
                border: '1px solid #01696F',
              }}
            >
              Claim manually
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#FAFAF7',
      }}
    >
      <div style={{ textAlign: 'center', color: '#28251D' }}>
        <div
          className="spinner"
          aria-label="Loading"
          style={{ margin: '0 auto 16px' }}
        />
        <p style={{ color: '#7A7974' }}>Loading your onboarding…</p>
      </div>
    </div>
  );
}
