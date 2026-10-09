/**
 * Where an IP address is, in words a person can read.
 *
 * Used once per recorded sign-in and never again: the answer is stored on
 * the row, because an address resolved months later tells you where it is
 * now, not where it was when somebody signed in from it.
 *
 * Everything here fails soft. A sign-in must not be delayed, and must
 * certainly not fail, because a free geolocation service was slow — an
 * unresolved location is a blank cell, which is honest.
 */

export interface Place {
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
}

const NOWHERE: Place = { city: null, region: null, country: null, countryCode: null };

/**
 * Addresses that are not on the internet and must never be sent to one.
 *
 * Loopback is the developer's own machine, and the RFC 1918 ranges are
 * somebody's office LAN. Looking either up leaks an internal address to a
 * third party in exchange for a guaranteed "unknown".
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  if (!addr) return true;
  if (addr === '::1' || addr === '0.0.0.0' || addr === 'localhost') return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(addr) || addr.startsWith('fe80:')) return true;
  return (
    /^127\./.test(addr) ||
    /^10\./.test(addr) ||
    /^192\.168\./.test(addr) ||
    /^169\.254\./.test(addr) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(addr)
  );
}

/**
 * Answers already given, so a studio signing in from one office does not
 * call out once per sign-in. Unbounded growth is not a risk at this size,
 * but the sweep keeps it honest on a long-lived process.
 */
const CACHE_TTL_MS = 24 * 60 * 60_000;
const cache = new Map<string, { place: Place; at: number }>();

/**
 * How long the lookup may hold up recording a sign-in.
 *
 * Deliberately short. The row matters; the city on it is a nicety, and a
 * slow third party must not keep the sign-in screen waiting on an audit
 * write it does not even read the answer to.
 */
const TIMEOUT_MS = 1_800;

/**
 * ipwho.is — https, no key, no account. Chosen over ip-api.com, whose free
 * tier is http-only: resolving an address over plaintext in order to write
 * it into a security log is the wrong trade.
 */
async function ask(ip: string): Promise<Place> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country,country_code`, {
      signal: control.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return NOWHERE;
    const body = (await res.json()) as {
      success?: boolean;
      city?: string;
      region?: string;
      country?: string;
      country_code?: string;
    };
    // The service answers 200 with success:false for an address it cannot
    // place, so the status alone is not the test.
    if (!body?.success) return NOWHERE;
    return {
      city: body.city?.trim() || null,
      region: body.region?.trim() || null,
      country: body.country?.trim() || null,
      countryCode: body.country_code?.trim().toUpperCase() || null,
    };
  } catch {
    // Aborted, offline, rate-limited, malformed — all the same answer.
    return NOWHERE;
  } finally {
    clearTimeout(timer);
  }
}

/** Where this address is, or blanks. Never throws. */
export async function locate(ip: string | null): Promise<Place> {
  if (!ip || isPrivateAddress(ip)) return NOWHERE;

  const now = Date.now();
  const seen = cache.get(ip);
  if (seen && now - seen.at < CACHE_TTL_MS) return seen.place;

  const place = await ask(ip);
  cache.set(ip, { place, at: now });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  }
  return place;
}
