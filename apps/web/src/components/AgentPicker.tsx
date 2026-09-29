import { useEffect, useRef, useState, type SVGProps } from 'react';
import { AGENT_KEYS, AGENT_LABELS, AGENT_BLURBS, type AgentKey } from '@janelle/shared';
import { IconInbox, IconVendors, IconProjects, IconPlus, IconReport } from './icons';

type IconProps = SVGProps<SVGSVGElement>;
const stroke = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

/** Two overlapping masks — switching who she is right now, not what she does. */
const IconAgents = (p: IconProps) => (
  <svg {...stroke} {...p}>
    <path d="M8 3.5a4 4 0 0 0-4 4v2a4 4 0 0 0 4 4" />
    <path d="M16 3.5a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4" />
    <path d="M4 20.5a4 4 0 0 1 8 0" />
    <path d="M12 20.5a4 4 0 0 1 8 0" />
  </svg>
);

const AGENT_ICON: Record<AgentKey, (p: IconProps) => JSX.Element> = {
  inbox: IconInbox,
  vendors: IconVendors,
  projects: IconProjects,
  george: IconPlus,
  chief: IconReport,
};

/**
 * Which of Jenny's named personas are switched on, if any.
 *
 * Picking none is the default, unrestricted assistant. Picking one narrows
 * her to that domain — she declines anything outside it, by name, rather
 * than quietly answering from everywhere. Picking more than one lets her
 * work across just those, together.
 */
export function AgentPicker({ agents, onChange }: { agents: AgentKey[]; onChange: (next: AgentKey[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const toggle = (key: AgentKey) =>
    onChange(agents.includes(key) ? agents.filter((a) => a !== key) : [...agents, key]);

  const label =
    agents.length === 0 ? 'Agents'
    : agents.length === 1 ? AGENT_LABELS[agents[0]]
    : `${agents.length} agents`;

  return (
    <div ref={box} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={agents.length ? `Agents: ${label}. Change which of Jenny's abilities are on` : 'Choose which of Jenny’s abilities are on'}
        title="Narrow Jenny to one job, or a few, at once"
        className={`focusable flex h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium transition-colors ${
          agents.length ? 'bg-brass/10 text-brass-deep hover:bg-brass/15' : 'text-ink-soft hover:bg-sunk hover:text-ink'
        }`}
      >
        <IconAgents width={16} height={16} />
        <span>{label}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose which agents are on"
          className="absolute bottom-full left-0 z-30 mb-1.5 w-80 overflow-hidden rounded-xl border border-line bg-surface p-3 shadow-pop"
        >
          <p className="mb-2 text-[11.5px] leading-snug text-ink-faint">
            Narrow Jenny to one job, or pick a few to work together. Nothing on means everything is.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_KEYS.map((key) => {
              const on = agents.includes(key);
              const Icon = AGENT_ICON[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  title={AGENT_BLURBS[key]}
                  onClick={() => toggle(key)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    on ? 'border-brass bg-brass/15 text-ink' : 'border-line text-ink-soft hover:border-ink-faint hover:text-ink'
                  }`}
                >
                  <Icon width={14} height={14} />
                  {AGENT_LABELS[key]}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
