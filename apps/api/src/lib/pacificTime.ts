/**
 * The studio is in Ojai, California — the midday reminder and the evening
 * pop-up are both anchored to Pacific time, not the server's (UTC on
 * Vercel) or whichever time zone a machine polling the cron happens to be
 * in.
 *
 * Read via Intl against the IANA database rather than a fixed UTC offset,
 * so it stays correct across the PST/PDT change without a lookup table.
 */
const PACIFIC_TZ = 'America/Los_Angeles';

/** The Pacific wall-clock hour (0–23) at the given instant. */
export function pacificHourNow(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC_TZ, hour: 'numeric', hour12: false }).format(now),
  );
}

/**
 * A calendar date in the studio's time zone, as YYYY-MM-DD, `offsetDays` from today.
 *
 * "Today" cannot be read off the server's clock: Vercel runs in UTC, and the
 * 5pm Pacific reminder fires at midnight or 1am UTC — already tomorrow's date
 * there — so a task due today would have read as overdue in its own reminder.
 * The offset is added to the date, not to the instant, so a daylight-saving
 * change never skips or repeats a day.
 */
export function pacificDate(offsetDays = 0, now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC_TZ }).format(now);
  if (!offsetDays) return today;
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * The instant the studio's current day began — midnight Pacific.
 *
 * "Finished today" needs a start to measure from, and midnight UTC is the
 * wrong one: it falls in the afternoon in California, so the 5pm wrap-up would
 * have counted from the middle of yesterday's working day.
 */
export function pacificDayStart(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some engines print midnight as "24".
  const sinceMidnightMs = (((get('hour') % 24) * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnightMs);
}
