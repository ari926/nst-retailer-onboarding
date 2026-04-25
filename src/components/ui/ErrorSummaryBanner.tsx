import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import type { FieldErrors, FieldValues } from 'react-hook-form';

/**
 * Top-of-form error summary.
 *
 * Appears only when `errors` has content. Lists every invalid field as an
 * anchor link that focuses and scrolls the underlying input into view. The
 * banner itself gets focus on mount so screen-reader users hear the summary
 * and keyboard users can tab into the list.
 *
 * Caller provides `labels`: a map from field path (e.g. "keyHolders.0.name")
 * to a human-readable string. Anything not in the map is shown by its raw
 * path, so it's better to keep the map exhaustive.
 */
export function ErrorSummaryBanner<T extends FieldValues = FieldValues>({
  errors,
  labels,
}: {
  errors: FieldErrors<T>;
  labels: Record<string, string>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const flat = flattenErrors(errors);

  useEffect(() => {
    if (flat.length > 0) {
      ref.current?.focus();
    }
  }, [flat.length]);

  if (flat.length === 0) return null;

  const onLinkClick = (name: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el =
      (document.querySelector(`[name="${cssEscape(name)}"]`) as HTMLElement | null) ??
      (document.getElementById(name) as HTMLElement | null);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => (el as HTMLInputElement).focus({ preventScroll: true }), 250);
  };

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="banner banner-error stack stack-xs"
      style={{ display: 'block' }}
    >
      <div className="row row-sm" style={{ alignItems: 'center', gap: 'var(--space-2)' }}>
        <AlertCircle size={16} aria-hidden="true" />
        <strong>
          {flat.length === 1
            ? t('global.form.error_summary_title_one', 'Please fix 1 field before continuing.')
            : t('global.form.error_summary_title_other', 'Please fix {count} fields before continuing.', {
                count: flat.length,
              })}
        </strong>
      </div>
      <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
        {flat.map(({ name, message }) => (
          <li key={name}>
            <a
              href={`#${name}`}
              onClick={onLinkClick(name)}
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              {labels[name] ?? name}
            </a>
            {message ? <>: {message}</> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FlatError {
  name: string;
  message?: string;
}

function flattenErrors(errors: FieldErrors, prefix = ''): FlatError[] {
  const out: FlatError[] = [];
  for (const key of Object.keys(errors)) {
    const entry = (errors as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') continue;

    const path = prefix ? `${prefix}.${key}` : key;
    const obj = entry as Record<string, unknown>;

    if ('message' in obj && typeof obj.message === 'string') {
      out.push({ name: path, message: obj.message });
      continue;
    }

    // Nested — recurse.
    out.push(...flattenErrors(entry as FieldErrors, path));
  }
  return out;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
