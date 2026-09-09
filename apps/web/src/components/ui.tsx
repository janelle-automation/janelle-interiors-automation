import type { ReactNode } from 'react';
import { STAGE_LABELS, type ProjectStage } from '@janelle/shared';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
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
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${toneDot[tone]}`} aria-hidden="true" />
        <div className="text-[12.5px] font-medium text-ink-soft">{label}</div>
      </div>
      <div className={`mt-2.5 text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums ${toneText[tone]}`}>
        {value}
      </div>
      {hint && <div className="mt-2 text-[12.5px] text-ink-faint">{hint}</div>}
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

export function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
