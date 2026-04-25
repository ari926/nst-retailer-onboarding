/**
 * analytics.ts
 *
 * Thin analytics shim. V1 logs events to console in dev and pushes to a
 * `dataLayer` if GTM ever lands. For now we intentionally avoid a real
 * vendor (Segment / Amplitude / etc.) to keep the bundle small and skip
 * a CMP review — add the real adapter here later behind the same API.
 *
 * Events use a `noun.verb` or `noun.verb_past` convention so they read
 * naturally in funnels ("home.claim_clicked", "step_1.saved").
 */

type EventProps = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    __nst_events__?: Array<{ event: string; props: EventProps; ts: number }>;
  }
}

const DEV = import.meta.env.DEV;

export function trackEvent(event: string, props: EventProps = {}): void {
  const payload = {
    event,
    props,
    ts: Date.now(),
  };

  // Keep a rolling buffer in memory for debugging / E2E assertions.
  if (typeof window !== 'undefined') {
    window.__nst_events__ = window.__nst_events__ ?? [];
    window.__nst_events__.push(payload);
    if (window.__nst_events__.length > 200) window.__nst_events__.shift();

    // Push to GTM dataLayer if it exists (no-op otherwise).
    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event, ...props });
    }
  }

  if (DEV) {
    // eslint-disable-next-line no-console
    console.debug('[analytics]', event, props);
  }
}

/**
 * Identify a retailer once we have an SFDC account id. Safe to call
 * multiple times — later calls replace the prior identity.
 */
export function identify(sfdcAccountId: string, traits: EventProps = {}): void {
  if (typeof window === 'undefined') return;
  window.__nst_events__ = window.__nst_events__ ?? [];
  window.__nst_events__.push({
    event: '$identify',
    props: { sfdcAccountId, ...traits },
    ts: Date.now(),
  });
  if (DEV) {
    // eslint-disable-next-line no-console
    console.debug('[analytics] identify', sfdcAccountId, traits);
  }
}
