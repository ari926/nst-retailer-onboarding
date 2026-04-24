/**
 * NST wordmark. SVG-only, no external image asset, no bank logos anywhere.
 * Uses CSS tokens so it inherits the current theme.
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <div
      role="img"
      aria-label="National Secure Transport"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="var(--nst-dark)" />
        <path
          d="M8 10 L8 22 L11 22 L11 15 L21 22 L24 22 L24 10 L21 10 L21 17 L11 10 Z"
          fill="var(--nst-teal)"
        />
      </svg>
      <span
        style={{
          fontWeight: 'var(--fw-semibold)',
          fontSize: 'var(--fs-base)',
          color: 'var(--text-primary)',
          letterSpacing: '-0.01em',
        }}
      >
        NST
      </span>
    </div>
  );
}
