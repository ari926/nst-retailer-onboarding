import { useCallback } from 'react';
import type { FieldErrors, FieldValues } from 'react-hook-form';

/**
 * Returns an `onInvalid` callback for RHF's `handleSubmit(onValid, onInvalid)`.
 *
 * When a submit fails validation, finds the first errored field (in RHF's
 * declaration order — which matches DOM order) and scrolls it into view with
 * focus. Falls back gracefully if the element can't be located (array fields,
 * nested objects).
 *
 * Usage:
 *   const onInvalid = useScrollToFirstError();
 *   <form onSubmit={handleSubmit(onValid, onInvalid)}>
 */
export function useScrollToFirstError<T extends FieldValues = FieldValues>() {
  return useCallback((errors: FieldErrors<T>) => {
    const firstName = findFirstErrorName(errors);
    if (!firstName) return;

    const el =
      (document.querySelector(`[name="${cssEscape(firstName)}"]`) as HTMLElement | null) ??
      (document.getElementById(firstName) as HTMLElement | null) ??
      (document.querySelector(`[name^="${cssEscape(firstName.split('.')[0])}"]`) as HTMLElement | null);

    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof (el as HTMLInputElement).focus === 'function') {
      // Defer focus so it doesn't fight the scroll animation.
      setTimeout(() => (el as HTMLInputElement).focus({ preventScroll: true }), 250);
    }
  }, []);
}

// Walk RHF's error tree and return the first leaf field path (e.g. "foo" or
// "keyHolders.0.name"). Leaf errors have a string `message` — we stop at those
// rather than recursing into `ref`, which would chase DOM element properties.
function findFirstErrorName(errors: FieldErrors, prefix = ''): string | null {
  for (const key of Object.keys(errors)) {
    const entry = (errors as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') continue;

    const path = prefix ? `${prefix}.${key}` : key;
    const obj = entry as Record<string, unknown>;

    // RHF leaf: has a string `message`. Stop here.
    if (typeof obj.message === 'string') {
      return path;
    }

    // Container (object or array) — recurse.
    const nested = findFirstErrorName(entry as FieldErrors, path);
    if (nested) return nested;
  }
  return null;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
