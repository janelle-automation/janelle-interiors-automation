import type { ReactNode } from 'react';
import type { TaskCategory } from '@janelle/shared';

/**
 * One colour per KIND of thing, used the same way on every page: a task
 * category is always the same colour, a person always has the same avatar
 * colour, a project always the same dot. Blue stays "act here" and green /
 * amber / red stay status — these hues only say "which one".
 *
 * `nav` is the bright shade for the navy sidebar, which is dark in both themes.
 *
 * Class names are written out in full (not built from strings) so Tailwind
 * finds them when it scans the source.
 */
export type Hue = 'pink' | 'teal' | 'orange' | 'indigo' | 'green' | 'amber' | 'violet' | 'sky';

export const HUES: Hue[] = ['teal', 'indigo', 'orange', 'pink', 'sky', 'violet', 'green', 'amber'];

export const HUE: Record<Hue, { dot: string; text: string; soft: string; ring: string; edge: string; top: string; nav: string }> = {
  pink:   { dot: 'bg-hue-pink',   text: 'text-hue-pink-ink',   soft: 'bg-hue-pink/10',   ring: 'ring-hue-pink/25',   edge: 'border-l-hue-pink',   top: 'border-t-hue-pink', nav: 'text-[rgb(249_168_212)]' },
  teal:   { dot: 'bg-hue-teal',   text: 'text-hue-teal-ink',   soft: 'bg-hue-teal/10',   ring: 'ring-hue-teal/25',   edge: 'border-l-hue-teal',   top: 'border-t-hue-teal', nav: 'text-[rgb(94_234_212)]' },
  orange: { dot: 'bg-hue-orange', text: 'text-hue-orange-ink', soft: 'bg-hue-orange/10', ring: 'ring-hue-orange/25', edge: 'border-l-hue-orange', top: 'border-t-hue-orange', nav: 'text-[rgb(253_186_116)]' },
  indigo: { dot: 'bg-hue-indigo', text: 'text-hue-indigo-ink', soft: 'bg-hue-indigo/10', ring: 'ring-hue-indigo/25', edge: 'border-l-hue-indigo', top: 'border-t-hue-indigo', nav: 'text-[rgb(165_180_252)]' },
  green:  { dot: 'bg-hue-green',  text: 'text-hue-green-ink',  soft: 'bg-hue-green/10',  ring: 'ring-hue-green/25',  edge: 'border-l-hue-green',  top: 'border-t-hue-green', nav: 'text-[rgb(134_239_172)]' },
  amber:  { dot: 'bg-hue-amber',  text: 'text-hue-amber-ink',  soft: 'bg-hue-amber/10',  ring: 'ring-hue-amber/25',  edge: 'border-l-hue-amber',  top: 'border-t-hue-amber', nav: 'text-[rgb(252_211_77)]' },
  violet: { dot: 'bg-hue-violet', text: 'text-hue-violet-ink', soft: 'bg-hue-violet/10', ring: 'ring-hue-violet/25', edge: 'border-l-hue-violet', top: 'border-t-hue-violet', nav: 'text-[rgb(216_180_254)]' },
  sky:    { dot: 'bg-hue-sky',    text: 'text-hue-sky-ink',    soft: 'bg-hue-sky/10',    ring: 'ring-hue-sky/25',    edge: 'border-l-hue-sky',    top: 'border-t-hue-sky', nav: 'text-[rgb(125_211_252)]' },
};

/** The studio's four categories, fixed so they never swap colours. */
export const CATEGORY_HUE: Record<TaskCategory, Hue> = {
  design: 'pink',
  ffe: 'teal',
  procurement: 'orange',
  admin: 'indigo',
};

/**
 * A stable colour for a name — the same person or project gets the same
 * colour on every page and every visit, without storing anything.
 */
export function hueFor(name: string | null | undefined): Hue {
  const s = (name ?? '').trim().toLowerCase();
  if (!s) return 'sky';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

/** A small filled circle in a hue. */
export function HueDot({ hue, className = '' }: { hue: Hue; className?: string }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${HUE[hue].dot} ${className}`} aria-hidden="true" />;
}

/** A label tinted in a hue — a category, a kind. */
export function HueTag({ hue, children, className = '' }: { hue: Hue; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ring-1 ring-inset ${HUE[hue].soft} ${HUE[hue].text} ${HUE[hue].ring} ${className}`}>
      <HueDot hue={hue} className="h-1.5 w-1.5" />
      {children}
    </span>
  );
}

/** A task category as a coloured tag. */
export function CategoryTag({ category, label, className }: { category: TaskCategory; label: ReactNode; className?: string }) {
  return <HueTag hue={CATEGORY_HUE[category]} className={className}>{label}</HueTag>;
}

/** Up to two initials: "Carissa Kolbeck" → "CK", "info@studio.com" → "I". */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

/** A person's initials in their own colour. */
export function Avatar({ name, size = 24, className = '' }: { name: string | null | undefined; size?: number; className?: string }) {
  const hue = hueFor(name);
  return (
    <span
      className={`inline-grid shrink-0 place-items-center rounded-full font-semibold ring-1 ring-inset ${HUE[hue].soft} ${HUE[hue].text} ${HUE[hue].ring} ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      title={name ?? undefined}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/** A project's name with its colour dot in front. */
export function ProjectName({ name, className = '' }: { name: string; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <HueDot hue={hueFor(name)} />
      <span className="truncate">{name}</span>
    </span>
  );
}
