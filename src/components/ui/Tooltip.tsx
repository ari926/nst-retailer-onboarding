import { useState, useRef, useEffect, type ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

interface TooltipProps {
  /** The content shown when hovered/focused. */
  content: ReactNode;
  /** Optional aria-label for the trigger button. */
  ariaLabel?: string;
  /** Optional override for the trigger icon. Defaults to a lucide HelpCircle. */
  children?: ReactNode;
}

/**
 * Lightweight, accessible tooltip — hover OR keyboard-focus to reveal.
 *
 * Used for inline field-level help (e.g. "what is a sealed bag number?").
 * Closes on Escape and on click-away. No portal — content renders in a
 * sibling `<span>` positioned above the trigger via CSS.
 */
export function Tooltip({ content, ariaLabel = 'More info', children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className="tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="tooltip-trigger"
        aria-label={ariaLabel}
        aria-describedby={open ? 'tooltip-bubble' : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        {children ?? <HelpCircle size={14} aria-hidden />}
      </button>
      {open && (
        <span id="tooltip-bubble" role="tooltip" className="tooltip-bubble">
          {content}
        </span>
      )}
    </span>
  );
}
