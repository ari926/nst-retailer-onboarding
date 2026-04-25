/**
 * NST wordmark. The official logo (white-on-transparent PNG from
 * nationalsecuretransport.com) is rendered inside a navy tile so it stays
 * legible on the light header.
 */
export function Logo({ size = 36 }: { size?: number }) {
  // Logo is 731×231 → ~3.16:1 aspect; we render it at the requested height
  // and let width scale.
  const padding = Math.round(size * 0.18);
  return (
    <div
      role="img"
      aria-label="National Secure Transport"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--nst-dark)',
        borderRadius: 'var(--radius-sm)',
        padding: `${padding}px ${padding * 1.4}px`,
        height: size,
      }}
    >
      <img
        src={`${import.meta.env.BASE_URL}nst-logo.png`}
        alt=""
        aria-hidden="true"
        style={{ height: '100%', width: 'auto', display: 'block' }}
      />
    </div>
  );
}
