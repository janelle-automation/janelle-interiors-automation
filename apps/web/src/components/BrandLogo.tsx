/**
 * The studio's logo, drawn in whatever colour the surrounding text is.
 *
 * The artwork is black ink on transparency, used as a mask, so the same file
 * reads as dark ink on the light theme and light ink on the dark theme and
 * the sidebar — no second copy for each background.
 */
export function BrandLogo({
  className = '',
  label = 'Janelle Interiors',
  variant = 'full',
}: {
  className?: string;
  label?: string;
  /** `mark` is the hexagon and signature alone, for places too small to read the wordmark. */
  variant?: 'full' | 'mark';
}) {
  const src = variant === 'mark' ? '/logo-mark.png' : '/logo.png';
  return (
    <span
      role="img"
      aria-label={label}
      className={`block ${variant === 'mark' ? 'aspect-[520/320]' : 'aspect-[798/529]'} bg-current ${className}`}
      style={{
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }}
    />
  );
}
