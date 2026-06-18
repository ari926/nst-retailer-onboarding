import type { FieldErrors } from 'react-hook-form';
import toast from 'react-hot-toast';

/**
 * Builds a `react-hook-form` invalid-submit handler that:
 *   1. Counts the errors and shows a single, prominent toast so the user
 *      can't miss that something blocked submission (the inline "Required"
 *      labels alone are too easy to skim past — see V2 cleanup, Jason's
 *      Step 2 stuck report on 2026-04-27).
 *   2. Scrolls the first invalid field into view and focuses it, so the
 *      user lands directly on the thing they need to fix.
 *
 * Pass the i18n `t` function so messages localize (en/es). Falls back to
 * English if not provided.
 */
export function makeInvalidHandler(
  t?: (key: string, fallback?: string, vars?: Record<string, unknown>) => string,
) {
  const tr = (key: string, fallback: string, vars?: Record<string, unknown>) =>
    t ? t(key, fallback, vars) : fallback;

  return function onInvalid(errors: FieldErrors): void {
    const count = countErrors(errors);
    if (count === 0) return;

    toast.error(
      count === 1
        ? tr(
            'global.errors.fix_one_field',
            'Please fix the highlighted field below before continuing.',
          )
        : tr(
            'global.errors.fix_n_fields',
            `Please fix the ${count} highlighted fields below before continuing.`,
            { count },
          ),
      { id: 'form-invalid', duration: 4500 },
    );

    // Defer one frame so React has rendered the error styling before
    // we measure positions.
    requestAnimationFrame(() => {
      const firstName = firstErrorPath(errors);
      if (!firstName) return;
      const el =
        (document.querySelector(
          `[name="${cssEscape(firstName)}"]`,
        ) as HTMLElement | null) ??
        // Fallback: react-hook-form sometimes registers field arrays where
        // the leaf is not a direct DOM `name`. Try a relaxed prefix match.
        (document.querySelector(
          `[name^="${cssEscape(firstName.split('.')[0])}"]`,
        ) as HTMLElement | null);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // focus() can fight scrollIntoView in Safari — call it after scroll
      // initiates so the cursor lands on the field but the page doesn't jump.
      setTimeout(() => {
        try {
          el.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }, 250);
    });
  };
}

/** Total leaf-level errors across the (possibly nested) error tree. */
function countErrors(errors: FieldErrors): number {
  let n = 0;
  walk(errors, () => {
    n += 1;
  });
  return n;
}

/** First error's dotted path (e.g. "keyHolders.0.name"). */
function firstErrorPath(errors: FieldErrors): string | null {
  let found: string | null = null;
  walk(errors, (path) => {
    if (!found) found = path;
  });
  return found;
}

function walk(
  node: unknown,
  visit: (path: string) => void,
  prefix = '',
): void {
  if (!node || typeof node !== 'object') return;
  // A react-hook-form error leaf has `message` / `type` / `ref` keys.
  const obj = node as Record<string, unknown>;
  if ('message' in obj || 'type' in obj) {
    if (prefix) visit(prefix);
    return;
  }
  for (const [key, child] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    walk(child, visit, path);
  }
}

/** Minimal CSS.escape polyfill for older Safari. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}
