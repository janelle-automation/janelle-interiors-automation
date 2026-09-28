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
