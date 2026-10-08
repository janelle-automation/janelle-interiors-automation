import { useState, type SVGProps } from 'react';
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
const IconCheck = (p: IconProps) => <svg {...stroke} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
const IconChevron = (p: IconProps) => <svg {...stroke} {...p}><path d="m6 9 6 6 6-6" /></svg>;
const IconX = (p: IconProps) => <svg {...stroke} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>;

export const AGENT_ICON: Record<AgentKey, (p: IconProps) => JSX.Element> = {
  inbox: IconInbox,
  vendors: IconVendors,
  projects: IconProjects,
  george: IconPlus,
  chief: IconReport,
};

/** What the choice is, in a line: nothing on means everything is. */
/**
 * Every agent on is the default, and reaches every tool Jenny has — so it is
 * not a narrowing and must not be described as one. Saying "declines anything
 * outside them" under five switches that between them cover everything is a
 * warning about a restriction that does not exist.
 */
const allOn = (agents: AgentKey[]): boolean => agents.length === AGENT_KEYS.length;

function summaryOf(agents: AgentKey[]): string {
  if (agents.length === 0) return 'None on — Jenny does everything';
  if (allOn(agents)) return `All ${agents.length} on — Jenny does everything`;
  if (agents.length === 1) return `${AGENT_LABELS[agents[0]]} only`;
  return `${agents.length} on: ${agents.map((a) => AGENT_LABELS[a]).join(', ')}`;
}

/**
 * Which of Jenny's named personas are switched on, if any — in the panel that
 * manages conversations, beside "New conversation" and the history.
 *
 * It used to be a button in the message box. That put a decision about who
 * Jenny IS for a whole conversation next to the box where each message is
 * typed, and it opened over the thread. It belongs with the other things that
 * set up a conversation, so it lives here: one row that says what is on, and
 * opens into the five agents, each with what it does written out rather than
 * hidden in a tooltip.
 *
 * Picking none is the default, unrestricted assistant. Picking one narrows her
 * to that domain — she declines anything outside it, by name, rather than
 * quietly answering from everywhere. Picking more than one lets her work
 * across just those, together.
 */
/** Whether the list is unfolded is remembered, so it is where the person left it. */
const OPEN_KEY = 'janelle.agents.open';

export function AgentList({ agents, onChange }: { agents: AgentKey[]; onChange: (next: AgentKey[]) => void }) {
  // Open unless it was closed on purpose: choosing an agent is the point of the
  // list, and one that folds itself away between visits reads as having lost it.
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      /* the choice just is not remembered */
    }
  };
  const toggle = (key: AgentKey) => onChange(agents.includes(key) ? agents.filter((a) => a !== key) : [...agents, key]);
  const active = agents.length > 0;

  return (
    <div className={`rounded-lg border ${active ? 'border-brass/50 bg-brass/5' : 'border-line'}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="focusable flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left"
      >
        <IconAgents width={16} height={16} className={active ? 'text-brass-deep' : 'text-ink-soft'} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-ink">Agents</span>
          <span className="block truncate text-[11.5px] text-ink-faint">{summaryOf(agents)}</span>
        </span>
        <IconChevron width={14} height={14} className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-line-soft p-2">
          <p className="mb-1.5 px-1 text-[11.5px] leading-snug text-ink-faint">
            Narrow Jenny to one job, or pick a few to work together.
          </p>
          <ul className="space-y-1">
            {AGENT_KEYS.map((key) => {
              const on = agents.includes(key);
              const Icon = AGENT_ICON[key];
              return (
                <li key={key}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(key)}
                    className={`focusable flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
                      on ? 'border-brass bg-brass/15' : 'border-transparent hover:bg-sunk'
                    }`}
                  >
                    <Icon width={15} height={15} className="mt-0.5 shrink-0 text-ink-soft" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-medium text-ink">{AGENT_LABELS[key]}</span>
                      <span className="block text-[11.5px] leading-snug text-ink-soft">{AGENT_BLURBS[key]}</span>
                    </span>
                    {on && <IconCheck width={15} height={15} className="mt-0.5 shrink-0 text-brass-deep" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {active && (
            <button type="button" onClick={() => onChange([])} className="focusable mt-2 rounded px-1 text-[12px] text-brass hover:underline">
              Turn all off
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A reminder in the message box that Jenny is narrowed, with a way out.
 * Shown only while one or more agents are on, so a restricted Jenny never
 * surprises someone who set it up in the side panel an hour ago.
 */
export function ActiveAgents({ agents, onClear }: { agents: AgentKey[]; onClear: () => void }) {
  // Nothing to warn about when none — or all — are on: both reach everything.
  if (agents.length === 0 || allOn(agents)) return null;
  const text = agents.length === 1 ? AGENT_LABELS[agents[0]] : `${agents.length} agents`;
  return (
    <button
      type="button"
      onClick={onClear}
      title={`Only ${agents.map((a) => AGENT_LABELS[a]).join(', ')} — click to turn off`}
      aria-label={`Jenny is narrowed to ${agents.map((a) => AGENT_LABELS[a]).join(', ')}. Turn off`}
      className="focusable flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brass/10 px-2 text-[12.5px] font-medium text-brass-deep transition-colors hover:bg-brass/15"
    >
      <IconAgents width={16} height={16} />
      <span>{text}</span>
      <IconX width={12} height={12} />
    </button>
  );
}

/**
 * The agents as a page of their own: one card each, what it does written out,
 * and one switch. The same setting as the compact list in the side panel —
 * this is the place to read about them and manage them without a conversation
 * open beside it.
 */
export function AgentCards({ agents, onChange }: { agents: AgentKey[]; onChange: (next: AgentKey[]) => void }) {
  const toggle = (key: AgentKey) => onChange(agents.includes(key) ? agents.filter((a) => a !== key) : [...agents, key]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <p className="text-[13px] text-ink-soft">
          {agents.length === 0
            ? 'No agent is on, so Jenny does everything. Switch one on to narrow her to that job, or several to work across just those.'
            : allOn(agents)
              ? 'All five are on, which is how Jenny starts: between them they cover everything she can do. Switch some off to narrow her to the rest.'
              : `${summaryOf(agents)}. Jenny declines anything outside ${agents.length === 1 ? 'it' : 'them'}, by name.`}
        </p>
        {agents.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="btn-secondary btn-sm">
            Turn all off
          </button>
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {AGENT_KEYS.map((key) => {
          const on = agents.includes(key);
          const Icon = AGENT_ICON[key];
          return (
            <li key={key}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(key)}
                className={`focusable flex h-full w-full flex-col gap-3 rounded-xl border p-4 text-left transition-colors ${
                  on ? 'border-brass bg-brass/10 shadow-card' : 'border-line bg-surface hover:border-ink-faint'
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className={`grid h-10 w-10 place-items-center rounded-lg ${on ? 'bg-brass text-white' : 'bg-sunk text-ink-soft'}`}>
                    <Icon width={20} height={20} />
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${
                      on ? 'bg-brass/20 text-brass-deep' : 'bg-sunk text-ink-faint'
                    }`}
                  >
                    {on ? 'On' : 'Off'}
                  </span>
                </span>
                <span>
                  <span className="block text-[15px] font-semibold text-ink">{AGENT_LABELS[key]}</span>
                  <span className="mt-1 block text-[13px] leading-snug text-ink-soft">{AGENT_BLURBS[key]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
