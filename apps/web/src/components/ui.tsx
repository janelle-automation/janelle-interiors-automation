import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { IconEye, IconEyeOff } from './icons';
import { STAGE_LABELS, type ProjectStage } from '@janelle/shared';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}

/**
 * A password field you can look at.
 *
 * Typing a long password blind and then typing it again blind is how people
 * end up locked out of an account they just set the password on — the two
 * fields agree, and both are wrong. Being able to see it is the fix, and it
 * matters most on exactly the screens where the stakes are highest.
 *
 * Starts hidden, always: someone reading over a shoulder is the reason the
 * dots exist. The eye shows the ACTION rather than the state — an eye means
 * "reveal" — which is the same convention the task board uses for its
 * closed-work toggle, and it matches the label beside it.
 */
export function PasswordInput({
  className = '',
  wrapperClassName = 'block',
  label: what = 'password',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** For a field that sits in a flex or grid row rather than on its own. */
  wrapperClassName?: string;
  /** What is being revealed, when it is not a password — "API key". */
  label?: string;
}) {
  const [shown, setShown] = useState(false);
  const label = `${shown ? 'Hide' : 'Show'} ${what}`;

  return (
    <span className={`relative ${wrapperClassName}`}>
      <input {...rest} type={shown ? 'text' : 'password'} className={`input pr-10 ${className}`} />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-pressed={shown}
        aria-label={label}
        title={label}
        className="focusable absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-ink-faint transition-colors hover:text-ink"
      >
        {shown ? <IconEyeOff width={16} height={16} /> : <IconEye width={16} height={16} />}
      </button>
    </span>
  );
}

/**
 * The frame every in-shell page sits in.
 *
 * AppShell gives a page its outer padding and its measure; this gives the
 * rhythm inside it. Pages used to each set their own — `space-y-8` on the
 * dashboard, `mb-6` hung off individual cards on Permissions and Reports,
 * nothing at all on a third — so the gap under a heading changed as you
 * moved between screens, which reads as three apps rather than one.
 *
 * One container owns that rhythm now. A page inside it should add no
 * vertical margin of its own; if a block needs to sit closer than the rest,
 * group it with its neighbour rather than reaching for a margin.
 */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`space-y-6 ${className}`}>{children}</div>;
}

export function PageHeading({
  eyebrow,
  title,
  sub,
  action,
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    // No bottom margin: the gap below a heading is the Page container's, so
    // that it is the same gap the rest of the page is built on.
    //
    // `items-start`, not `items-end`: bottom-aligning the buttons dropped
    // them to the foot of a two-line subtitle and left a band of nothing
    // beside the title, which is the widest part of the page. Level with the
    // title they read as belonging to it, and the empty band is gone.
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-0.5 text-[26px] font-bold leading-tight tracking-[-0.01em] text-ink">
          {title}
        </h1>
        {sub && <p className="mt-1 max-w-2xl text-[14px] text-ink-soft">{sub}</p>}
      </div>
      {action}
    </header>
  );
}

export type Tone = 'neutral' | 'brass' | 'good' | 'warn' | 'crit' | 'olive';

const toneText: Record<Tone, string> = {
  neutral: 'text-ink',
  brass: 'text-brass-deep',
  good: 'text-good',
  warn: 'text-warn',
  crit: 'text-crit',
  olive: 'text-olive',
};
const toneDot: Record<Tone, string> = {
  neutral: 'bg-ink-faint',
  brass: 'bg-brass',
  good: 'bg-good',
  warn: 'bg-warn',
  crit: 'bg-crit',
  olive: 'bg-olive',
};

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
}) {
  // Fills its grid cell rather than shrinking to its own content: labels
  // and hints wrap to different numbers of lines, so content-sized tiles
  // came out at different heights along the same row. The hint is pushed to
  // the bottom so the figures line up across the row whatever the wrapping.
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-center gap-2">
        <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${toneDot[tone]}`} aria-hidden="true" />
        <div className="text-[12.5px] font-medium text-ink-soft">{label}</div>
      </div>
      <div className={`mt-2.5 text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums ${toneText[tone]}`}>
        {value}
      </div>
      {hint && <div className="mt-auto pt-2 text-[12.5px] text-ink-faint">{hint}</div>}
    </Card>
  );
}

const stageTone: Record<ProjectStage, string> = {
  lead: 'text-ink-soft bg-sunk',
  concept: 'text-ink-soft bg-sunk',
  spec: 'text-olive bg-olive/10',
  approval: 'text-warn bg-warn/10',
  po: 'text-brass-deep bg-brass/10',
  production: 'text-brass-deep bg-brass/10',
  shipping: 'text-olive bg-olive/10',
  install: 'text-good bg-good/10',
  complete: 'text-ink-faint bg-sunk',
};

export function StageBadge({ stage }: { stage: ProjectStage }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[12px] font-semibold ${stageTone[stage]}`}
    >
      {STAGE_LABELS[stage]}
    </span>
  );
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'crit' | 'brass';
}) {
  const tones: Record<string, string> = {
    neutral: 'text-ink-soft bg-sunk ring-line',
    good: 'text-good bg-good/10 ring-good/25',
    warn: 'text-warn bg-warn/10 ring-warn/25',
    crit: 'text-crit bg-crit/10 ring-crit/25',
    brass: 'text-brass-deep bg-brass/10 ring-brass/25',
  };
  return (
    // A hairline ring in the pill's own colour gives it an edge on both
    // white and tinted rows, so a status is read as a label at a glance.
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * An on/off switch. Reads as a control at a glance, which a coloured dot
 * does not — you can see the state, and see that you may change it.
 *
 * `marked` draws attention to a value that differs from its default.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  marked = false,
  label,
  title,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  marked?: boolean;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled || !onChange}
      onClick={() => onChange?.(!checked)}
      className={[
        'focusable relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-brass' : 'bg-ink-faint/30',
        disabled || !onChange ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:opacity-85',
        marked ? 'ring-2 ring-brass/40 ring-offset-1 ring-offset-surface' : '',
      ].join(' ')}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

export function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Paging ──────────────────────────────────────────────────

/**
 * A themed stand-in for `window.confirm`.
 *
 * The browser's own version breaks immersion the moment it appears — a
 * plain system box captioned "localhost:5173 says", sitting on top of a
 * dark, branded app — and it can only ever show plain text, never the
 * record's own styling. Renders nothing while `open` is false.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red "Delete"-style confirm button vs. the ordinary brass primary one. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} aria-hidden />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm rounded-xl border border-line bg-surface p-5 shadow-pop"
      >
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {message && <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">{message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-ghost btn-sm">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={danger ? 'btn-secondary btn-sm text-crit hover:border-crit' : 'btn-primary btn-sm'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
