import { useEffect, useRef, useState } from 'react';
import { IconCalendar, IconChevronLeft, IconChevronRight } from './icons';

/**
 * A start-and-end date picker drawn in the app's own colours.
 *
 * The browser's `<input type="date">` looked like a different product — a
 * grey system popup over a dark screen, and two full-width fields for what
 * is one choice. This is one field and one calendar: click the first day,
 * then the last, and the days between fill in as you go.
 *
 * Dates are local midnights. Weeks start on Monday.
 */

export interface DateRange {
  from: Date | null;
  to: Date | null;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_MS = 86_400_000;

const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a: Date | null, b: Date | null) => !!a && !!b && a.getTime() === b.getTime();
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
/** Whole days from a to b, counting both. */
const spanDays = (a: Date, b: Date) => Math.round((dayOf(b).getTime() - dayOf(a).getTime()) / DAY_MS) + 1;

function formatDay(d: Date, withYear = true): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}

export function formatRange(from: Date | null, to: Date | null): string {
  if (!from) return '';
  if (!to || sameDay(from, to)) return formatDay(from);
  const sameYear = from.getFullYear() === to.getFullYear();
  return `${formatDay(from, !sameYear)} – ${formatDay(to)}`;
}

/** The 42 cells of a month grid: leading and trailing days from its neighbours. */
function monthCells(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  return Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - lead + i));
}

function Month({
  month,
  from,
  to,
  hover,
  isDisabled,
  onPick,
  onHover,
}: {
  month: Date;
  from: Date | null;
  to: Date | null;
  hover: Date | null;
  isDisabled: (d: Date) => boolean;
  onPick: (d: Date) => void;
  onHover: (d: Date | null) => void;
}) {
  const today = dayOf(new Date());
  // While only the start is chosen, the day under the pointer previews the end.
  const end = to ?? (from && hover && hover >= from ? hover : null);

  return (
    <div className="w-[252px]">
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            {w}
          </div>
        ))}
        {monthCells(month).map((d) => {
          const outside = d.getMonth() !== month.getMonth();
          // Neighbouring months' days are left blank: showing them twice,
          // once in each month, made a range look like it had holes.
          if (outside) return <div key={d.getTime()} className="h-9" aria-hidden="true" />;

          const disabled = isDisabled(d);
          const isStart = sameDay(d, from);
          const isEnd = sameDay(d, end);
          const inRange = !!from && !!end && d > from && d < end;
          const endpoint = isStart || isEnd;
          const band = (inRange || (endpoint && !!end && !sameDay(from, end)));

          return (
            <div
              key={d.getTime()}
              className={`relative h-9 ${
                band
                  ? `bg-brass/15 ${isStart ? 'rounded-l-lg' : ''} ${isEnd ? 'rounded-r-lg' : ''}`
                  : ''
              }`}
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(d)}
                onMouseEnter={() => onHover(d)}
                aria-label={d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                aria-pressed={endpoint}
                className={`focusable relative grid h-9 w-full place-items-center rounded-lg text-[13px] transition-colors ${
                  endpoint
                    ? 'bg-brass font-semibold text-white'
                    : disabled
                      ? 'cursor-not-allowed text-ink-faint/40'
                      : inRange
                        ? 'text-ink hover:bg-brass/25'
                        : 'text-ink hover:bg-sunk'
                }`}
              >
                {d.getDate()}
                {sameDay(d, today) && !endpoint && (
                  <span className="absolute bottom-1 h-1 w-1 rounded-full bg-brass" aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DateRangePicker({
  value,
  onChange,
  max,
  maxDays,
  disabled,
  defaultOpen = false,
  id,
}: {
  value: DateRange;
  onChange: (next: { from: Date; to: Date }) => void;
  /** The last day that may be picked. */
  max?: Date;
  /** The longest range allowed, counting both ends. */
  maxDays?: number;
  disabled?: boolean;
  defaultOpen?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen && !disabled);
  const [draft, setDraft] = useState<DateRange>(value);
  const [hover, setHover] = useState<Date | null>(null);
  const lastDay = max ? dayOf(max) : null;
  // The right-hand month; the left one is the month before. Opens on the
  // chosen end, or on today, so the recent past is what is in view.
  const [shown, setShown] = useState(() => addMonths(value.to ?? lastDay ?? new Date(), 0));
  const root = useRef<HTMLDivElement>(null);

  // Opening starts from what is actually chosen, not a half-finished pick
  // that was abandoned last time.
  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setHover(null);
    setShown(addMonths(value.to ?? lastDay ?? new Date(), 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choosingEnd = !!draft.from && !draft.to;
  const isDisabled = (d: Date) => {
    if (lastDay && d > lastDay) return true;
    // Past the longest allowed range from the start already chosen.
    if (choosingEnd && maxDays && d > draft.from! && spanDays(draft.from!, d) > maxDays) return true;
    return false;
  };

  const pick = (d: Date) => {
    if (!draft.from || draft.to || d < draft.from) setDraft({ from: d, to: null });
    else setDraft({ from: draft.from, to: d });
  };

  const apply = () => {
    if (!draft.from || !draft.to) return;
    onChange({ from: draft.from, to: draft.to });
    setOpen(false);
  };

  const left = addMonths(shown, -1);
  const atLatest = !!lastDay && shown.getFullYear() === lastDay.getFullYear() && shown.getMonth() === lastDay.getMonth();
  const monthTitle = (m: Date) => m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const label = formatRange(value.from, value.to);
  const draftEnd = draft.to ?? (choosingEnd && hover && hover >= draft.from! && !isDisabled(hover) ? hover : null);

  return (
    <div ref={root} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`input flex w-full items-center gap-2.5 text-left sm:w-auto sm:min-w-[300px] ${
          open ? 'border-brass/60' : ''
        } disabled:opacity-60`}
      >
        <IconCalendar width={16} height={16} className="shrink-0 text-ink-faint" />
        <span className={`flex-1 truncate ${label ? 'text-ink' : 'text-ink-faint'}`}>{label || 'Pick a start and end date'}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose a date range"
          className="absolute left-0 top-full z-30 mt-2 max-w-[calc(100vw-32px)] rounded-xl border border-line bg-surface p-4 shadow-pop"
          onMouseLeave={() => setHover(null)}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShown(addMonths(shown, -1))}
              className="focusable grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-sunk hover:text-ink"
              aria-label="Previous month"
            >
              <IconChevronLeft width={16} height={16} />
            </button>
            <div className="flex flex-1 justify-around text-[13px] font-semibold text-ink">
              <span className="hidden sm:inline">{monthTitle(left)}</span>
              <span>{monthTitle(shown)}</span>
            </div>
            <button
              type="button"
              disabled={atLatest}
              onClick={() => setShown(addMonths(shown, 1))}
              className="focusable grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-sunk hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Next month"
            >
              <IconChevronRight width={16} height={16} />
            </button>
          </div>

          <div className="flex gap-6">
            <div className="hidden sm:block">
              <Month month={left} from={draft.from} to={draft.to} hover={hover} isDisabled={isDisabled} onPick={pick} onHover={setHover} />
            </div>
            <Month month={shown} from={draft.from} to={draft.to} hover={hover} isDisabled={isDisabled} onPick={pick} onHover={setHover} />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
            <span className="text-[12px] text-ink-soft">
              {!draft.from
                ? 'Click the first day.'
                : !draftEnd
                  ? `From ${formatDay(draft.from)} — now click the last day.`
                  : `${formatRange(draft.from, draftEnd)} · ${spanDays(draft.from, draftEnd)} day${spanDays(draft.from, draftEnd) === 1 ? '' : 's'}`}
            </span>
            <div className="flex items-center gap-1.5">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={!draft.from || !draft.to} onClick={apply}>
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
