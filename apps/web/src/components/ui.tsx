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
    neutral: 'text-ink-soft bg-sunk',
    good: 'text-good bg-good/10',
    warn: 'text-warn bg-warn/10',
    crit: 'text-crit bg-crit/10',
    brass: 'text-brass-deep bg-brass/10',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${tones[tone]}`}>
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
 * Slice a list into pages. Filtering is the reason this needs care:
 * a search that shrinks the list to two rows while you are on page 6
 * would otherwise render an empty table, so the page is clamped to
 * what exists and the state is corrected on the way through.
 */
export function usePager<T>(items: T[], pageSize = 25) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pageCount);
  useEffect(() => {
    if (page !== current) setPage(current);
  }, [page, current]);
  const start = (current - 1) * pageSize;
  return {
    page: current,
    setPage,
    pageCount,
    rows: items.slice(start, start + pageSize),
    start,
    total: items.length,
  };
}

/** 1 … 4 5 6 … 12 — always the ends, always the neighbours, never a wall of numbers. */
function pageWindow(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pageCount - 1, page + 1);
  if (from > 2) out.push('…');
  for (let i = from; i <= to; i++) out.push(i);
  if (to < pageCount - 1) out.push('…');
  out.push(pageCount);
  return out;
}

/**
 * The footer under a paged table. Renders nothing at all when everything
 * fits on one page — an empty control bar is just a band of wasted height.
 */
export function Pager({
  page, pageCount, setPage, start, count, total, noun = 'row',
}: {
  page: number; pageCount: number; setPage: (p: number) => void;
  start: number; count: number; total: number; noun?: string;
}) {
  if (pageCount <= 1) return null;
  const last = start + count;
  const step = (d: number) => setPage(Math.min(pageCount, Math.max(1, page + d)));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft px-5 py-2.5">
      <span className="text-[12px] text-ink-faint">
        {start + 1}–{last} of {total} {noun}{total === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={page === 1}
          className="focusable rounded-lg px-2.5 py-1 text-[12.5px] text-ink-soft transition-colors hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint/50"
        >
          ‹ Prev
        </button>
        {pageWindow(page, pageCount).map((p, i) =>
          p === '…' ? (
            <span key={`gap${i}`} className="px-1 text-[12.5px] text-ink-faint">…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => setPage(p)}
              aria-current={p === page ? 'page' : undefined}
              className={`focusable min-w-[28px] rounded-lg px-2 py-1 text-[12.5px] tabular-nums transition-colors ${
                p === page ? 'bg-brass font-semibold text-white' : 'text-ink-soft hover:bg-sunk hover:text-ink'
              }`}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => step(1)}
          disabled={page === pageCount}
          className="focusable rounded-lg px-2.5 py-1 text-[12.5px] text-ink-soft transition-colors hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint/50"
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
