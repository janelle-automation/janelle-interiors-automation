import { type ReactNode, type SVGProps } from 'react';
import { ASSISTANT_NAME, canSupervise } from '@janelle/shared';
import { useAssistant } from '../context/AssistantContext';
import { useAuth } from '../context/AuthContext';

/**
 * What Jenny can do, shown where a person would otherwise have to guess:
 * at the start of a conversation, and on request from the full page.
 *
 * Every line is something to press. A complete question is asked at once; a
 * question that needs a name ("Create a task for …") is put in the box for
 * the person to finish; attaching a file and talking hands-free start those.
 */

type IconProps = SVGProps<SVGSVGElement>;
const stroke = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconSun = (p: IconProps) => <svg {...stroke} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
const IconCheckSquare = (p: IconProps) => <svg {...stroke} {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m8 12 3 3 5-6" /></svg>;
const IconFolder = (p: IconProps) => <svg {...stroke} {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
const IconMail = (p: IconProps) => <svg {...stroke} {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
const IconClip = (p: IconProps) => <svg {...stroke} {...p}><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.5 7" /></svg>;
const IconWave = (p: IconProps) => <svg {...stroke} {...p}><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>;
const IconHistory = (p: IconProps) => <svg {...stroke} {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>;

type Action =
  | { label: string; ask: string }
  | { label: string; fill: string }
  | { label: string; run: 'attach' | 'talk' };

interface Section {
  key: string;
  title: string;
  blurb: string;
  icon: ReactNode;
  actions: Action[];
}

function sectionsFor(supervisor: boolean, canTalk: boolean): Section[] {
  return [
    {
      key: 'today',
      title: 'Know what needs you',
      blurb: 'A briefing each day, and the late, the unassigned and the waiting whenever you ask.',
      icon: <IconSun />,
      actions: [
        { label: 'What needs me today?', ask: 'What needs me today?' },
        { label: "What's overdue?", ask: "What's overdue across the studio?" },
        { label: 'Who is carrying the most work?', ask: 'Who on the team is carrying the most live tasks?' },
      ],
    },
    {
      key: 'tasks',
      title: 'Tasks',
      blurb: 'Create, assign and move tasks by asking. Nothing is saved until you confirm it.',
      icon: <IconCheckSquare />,
      actions: [
        { label: 'Show my tasks', ask: 'Show my tasks' },
        { label: 'Create a task for…', fill: 'Create a task for ' },
        { label: 'Which emails still need a task?', ask: 'Which recent emails still have no task?' },
      ],
    },
    {
      key: 'projects',
      title: 'Projects, orders & vendors',
      blurb: 'Status, budgets, purchase orders and who to chase — one table instead of five screens.',
      icon: <IconFolder />,
      actions: [
        { label: 'List our active projects', ask: 'List our active projects' },
        { label: 'Which orders are late?', ask: 'Which purchase orders are late?' },
        { label: "What's the status of…", fill: "What's the status of " },
      ],
    },
    {
      key: 'email',
      title: supervisor ? 'Email & Drive' : 'Email & documents',
      blurb: supervisor
        ? 'Search the studio mailbox and Drive live, open attachments, and draft replies for you to send.'
        : 'Search the mail and documents the studio has read, and open their attachments.',
      icon: <IconMail />,
      actions: [
        { label: 'Send me the latest quote PDF', ask: 'Send me the latest quote PDF' },
        { label: 'Find emails from…', fill: 'Find the latest emails from ' },
        ...(supervisor ? [{ label: 'Draft a reply to…', fill: 'Draft a reply to ' } as Action] : []),
      ],
    },
    {
      key: 'files',
      title: 'Read a file',
      blurb: 'Attach a PDF or a photo — a floor plan, a quote, a damaged delivery — and ask about it. She can pull out the pages that answer you.',
      icon: <IconClip />,
      actions: [
        { label: 'Attach a file', run: 'attach' },
        { label: 'Pull the living room pages from…', fill: 'From the proposal, show me the living room furniture and decor pages for ' },
      ],
    },
    ...(canTalk
      ? [
          {
            key: 'talk',
            title: 'Talk hands-free',
            blurb: 'She answers aloud and listens again, waiting for you to finish. Say "yes" to confirm what she prepared.',
            icon: <IconWave />,
            actions: [{ label: 'Start talking', run: 'talk' } as Action],
          },
        ]
      : []),
    {
      key: 'history',
      title: 'Your conversations',
      blurb: 'Kept in this browser. Rename, pin, download or delete them from the list of conversations.',
      icon: <IconHistory />,
      actions: [],
    },
  ];
}

export function AssistantGuide({ compact = false, onDone }: { compact?: boolean; onDone?: () => void }) {
  const { send, setPrefill, requestAttach, setHandsFree, canListen, pending } = useAssistant();
  const { user } = useAuth();
  const sections = sectionsFor(canSupervise(user?.role ?? null), canListen);

  const run = (action: Action) => {
    if ('ask' in action) send(action.ask);
    else if ('fill' in action) setPrefill(action.fill);
    else if (action.run === 'attach') requestAttach();
    else setHandsFree(true);
    onDone?.();
  };

  return (
    <div className={compact ? 'space-y-2.5' : 'grid gap-3 sm:grid-cols-2'}>
      {sections
        .filter((s) => !compact || s.actions.length)
        .map((section) => (
          <section key={section.key} className="rounded-xl border border-line bg-surface p-3.5">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brass/10 text-brass-deep" aria-hidden="true">
                {section.icon}
              </span>
              <div className="min-w-0">
                <h3 className="text-[13.5px] font-semibold text-ink">{section.title}</h3>
                {!compact && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft">{section.blurb}</p>}
              </div>
            </div>
            {section.actions.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {section.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    disabled={pending && 'ask' in action}
                    onClick={() => run(action)}
                    title={'fill' in action ? 'Puts this in the box for you to finish' : undefined}
                    className="focusable rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[12.5px] text-ink-soft transition-colors hover:border-brass/50 hover:bg-brass/5 hover:text-ink disabled:opacity-50"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      {!compact && (
        <p className="text-[12px] text-ink-faint sm:col-span-2">
          {ASSISTANT_NAME} never sends email or changes a record on her own — anything she prepares waits for you.
        </p>
      )}
    </div>
  );
}
