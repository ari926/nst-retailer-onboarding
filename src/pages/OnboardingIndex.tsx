import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Download, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useOnboardingStore } from '../stores/onboardingStore';
import { STEPS } from '../types/onboarding';
import { generateHandoffPdf } from '../lib/handoffPdf';
import { getSyncStatus, type SfSyncSummary } from '../lib/salesforceService';

/**
 * /onboarding landing — routes user to their current step.
 * When all 7 steps are complete, shows the activation panel with a
 * "Download ops summary" CTA (the PDF handoff from PR #10).
 */
function SyncIndicator({ sync }: { sync: SfSyncSummary }) {
  const { t } = useTranslation();
  if (sync.hasFailures) {
    return (
      <div className="sync-indicator sync-indicator--error" role="status">
        <AlertTriangle size={16} />
        <span>
          {t(
            'onboarding.sync.failed',
            "Some steps didn't reach our ops system. Your NST rep will reach out shortly.",
          )}
        </span>
      </div>
    );
  }
  if (sync.allSynced) {
    return (
      <div className="sync-indicator sync-indicator--ok" role="status">
        <CheckCircle2 size={16} />
        <span>
          {t(
            'onboarding.sync.synced',
            'Synced with NST operations. Your rep has everything they need.',
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="sync-indicator sync-indicator--pending" role="status">
      <Loader2 size={16} className="spin" />
      <span>
        {t(
          'onboarding.sync.pending',
          'Syncing with NST operations…',
        )}
      </span>
    </div>
  );
}

export default function OnboardingIndex() {
  const { t } = useTranslation();
  const currentStep = useOnboardingStore((s) => s.currentStep);
  const completedSteps = useOnboardingStore((s) => s.completedSteps);
  const storefrontName = useOnboardingStore((s) => s.storefrontName);
  const sfdcAccountId = useOnboardingStore((s) => s.sfdcAccountId);

  const nextStep = STEPS.find((s) => s.id === currentStep) || STEPS[0];
  // Step 0 (claim) may or may not be in completedSteps; compare against the
  // real flow steps (1..7) rather than array length.
  const allDone = STEPS.every((s) => completedSteps.includes(s.id));
  const [downloading, setDownloading] = useState(false);
  const [sync, setSync] = useState<SfSyncSummary | null>(null);

  // Poll sync status every 3s while on the activation panel. Stops once all
  // rows are succeeded or any have failed.
  useEffect(() => {
    if (!allDone) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getSyncStatus(sfdcAccountId);
        if (!cancelled) setSync(s);
      } catch {
        // Non-fatal — UI falls back to neutral state.
      }
    };
    void tick();
    const handle = setInterval(() => {
      if (sync?.allSynced || sync?.hasFailures) {
        clearInterval(handle);
        return;
      }
      void tick();
    }, 3_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [allDone, sfdcAccountId, sync?.allSynced, sync?.hasFailures]);

  const handleDownload = () => {
    setDownloading(true);
    try {
      const filename = generateHandoffPdf({
        storefrontName: storefrontName ?? 'Store',
        sfdcAccountId,
      });
      toast.success(
        t('onboarding.handoff.downloaded', 'Downloaded {filename}', {
          filename,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PDF generation failed';
      toast.error(msg);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="stack stack-md">
      <div className="step-header">
        <div className="step-header__eyebrow">
          {t('onboarding.overview_eyebrow', 'Setup overview')}
        </div>
        <h1>
          {allDone
            ? t('onboarding.all_done_title', "Nice — you're ready to launch.")
            : t('onboarding.welcome_title', "Let's get your store set up.")}
        </h1>
        <p className="step-header__subtitle">
          {allDone
            ? t(
                'onboarding.all_done_subtitle',
                'Your operations team will confirm your launch date shortly.',
              )
            : t(
                'onboarding.welcome_subtitle',
                'Seven quick steps. You can save and come back anytime.',
              )}
        </p>
      </div>

      {allDone ? (
        <div className="step-card">
          <div className="stack stack-sm">
            <div className="callout callout--success">
              <CheckCircle2 size={20} />
              <div>
                <strong>
                  {t(
                    'onboarding.handoff.ready_title',
                    'All 7 steps submitted',
                  )}
                </strong>
                <p
                  className="text-muted"
                  style={{ marginTop: 4, fontSize: '0.9em' }}
                >
                  {t(
                    'onboarding.handoff.ready_sub',
                    "Your NST rep is lining up your launch date. Download a summary to keep for your records — it's the same doc ops uses to set up your store.",
                  )}
                </p>
              </div>
            </div>

            {/* Salesforce sync indicator */}
            {sync && <SyncIndicator sync={sync} />}

            <div
              className="row row-sm"
              style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}
            >
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDownload}
                disabled={downloading}
              >
                <Download size={16} style={{ marginRight: 6 }} />
                {downloading
                  ? t('onboarding.handoff.downloading', 'Preparing PDF…')
                  : t(
                      'onboarding.handoff.download_cta',
                      'Download ops summary',
                    )}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="step-card">
          <div className="stack stack-sm">
            <div
              className="text-xs text-muted"
              style={{
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              {t('onboarding.next_up', 'Next up')}
            </div>
            <div
              className="row row-sm"
              style={{ justifyContent: 'space-between' }}
            >
              <div>
                <div style={{ fontWeight: 'var(--fw-semibold)' }}>
                  Step {nextStep.id} — {t(nextStep.titleKey)}
                </div>
              </div>
              <Link to={nextStep.path} className="btn btn-primary">
                {t('global.buttons.continue')}
              </Link>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
