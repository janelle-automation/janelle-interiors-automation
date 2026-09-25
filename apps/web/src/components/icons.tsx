import type { SVGProps } from 'react';

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

type P = SVGProps<SVGSVGElement>;

export const IconDashboard = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="3" width="7" height="9" rx="1.2" /><rect x="14" y="3" width="7" height="5" rx="1.2" /><rect x="14" y="12" width="7" height="9" rx="1.2" /><rect x="3" y="16" width="7" height="5" rx="1.2" /></svg>
);
export const IconProjects = (p: P) => (
  <svg {...base} {...p}><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="M3 13l9 5 9-5" /><path d="M3 18l9 5 9-5" opacity=".5" /></svg>
);
export const IconVendors = (p: P) => (
  <svg {...base} {...p}><path d="M3 7h11v10H3z" /><path d="M14 10h4l3 3v4h-7" /><circle cx="7" cy="18" r="1.6" /><circle cx="17" cy="18" r="1.6" /></svg>
);
export const IconInbox = (p: P) => (
  <svg {...base} {...p}><path d="M3 5h18v14H3z" /><path d="m3 6 9 7 9-7" /></svg>
);
export const IconDoc = (p: P) => (
  <svg {...base} {...p}><path d="M14 3H6v18h12V7l-4-4Z" /><path d="M14 3v4h4" /><path d="M9 13h6M9 17h4" /></svg>
);
export const IconPrompt = (p: P) => (
  <svg {...base} {...p}><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" /><path d="M18 15.5 18.8 18 21 19l-2.2 1L18 22l-.8-2L15 19l2.2-1 .8-2.5Z" opacity=".6" /></svg>
);
export const IconBell = (p: P) => (
  <svg {...base} {...p}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
);
export const IconAssistant = (p: P) => (
  <svg {...base} {...p}><path d="M12 3a4 4 0 0 1 4 4v3a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4Z" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>
);
export const IconTeam = (p: P) => (
  <svg {...base} {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16.5 5.5a3 3 0 0 1 0 5.6" /><path d="M18 20a5.5 5.5 0 0 0-2.5-4.6" /></svg>
);
export const IconMic = (p: P) => (
  <svg {...base} {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>
);
/** Shown while listening, so the button reads as "stop", not "speak again". */
export const IconStop = (p: P) => (
  <svg {...base} {...p}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></svg>
);
export const IconSend = (p: P) => (
  <svg {...base} {...p}><path d="M4.5 12 20 4l-5 16-3.5-6.5L4.5 12Z" /><path d="m11.5 13.5 8.5-9.5" /></svg>
);
export const IconTask = (p: P) => (
  <svg {...base} {...p}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9z" /><path d="m9 13 2 2 4-4" /></svg>
);
export const IconReport = (p: P) => (
  <svg {...base} {...p}><path d="M4 20V4" /><path d="M4 20h16" /><rect x="7" y="12" width="3" height="5" /><rect x="12" y="8" width="3" height="9" /><rect x="17" y="14" width="3" height="3" /></svg>
);
export const IconSettings = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>
);
export const IconSun = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5 4 4M20 20l-1-1M19 5l1-1M4 20l1-1" /></svg>
);
export const IconMoon = (p: P) => (
  <svg {...base} {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const IconLogout = (p: P) => (
  <svg {...base} {...p}><path d="M15 4h4v16h-4" /><path d="M10 8 6 12l4 4" /><path d="M6 12h10" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconArrow = (p: P) => (
  <svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconKey = (p: P) => (
  <svg {...base} {...p}><circle cx="7.5" cy="15.5" r="3.5" /><path d="m10 13 8.5-8.5" /><path d="m15.5 7.5 2 2" /><path d="m18 5 2 2" /></svg>
);
export const IconActivity = (p: P) => (
  <svg {...base} {...p}><path d="M3 12h4l2 6 4-14 2 8h6" /></svg>
);

// ── Controls ────────────────────────────────────────────────
// Icon-only buttons where the meaning is carried by a shape people
// already know: a board, a list, an eye. Every one of them is paired
// with a title and an aria-label at the call site — an icon nobody can
// name is a button nobody presses.

/** One person: your own work. */
export const IconPerson = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
);
/** Two people: the whole studio's. */
export const IconPeople = (p: P) => (
  <svg {...base} {...p}><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16.5 5.5a3.2 3.2 0 0 1 0 5.9" /><path d="M18 20a5.6 5.6 0 0 0-2.4-4.6" /></svg>
);
/** Columns: the task board. */
export const IconBoard = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="4" width="5" height="16" rx="1.4" /><rect x="9.5" y="4" width="5" height="11" rx="1.4" /><rect x="16" y="4" width="5" height="14" rx="1.4" /></svg>
);
/** Rows: the same work as a list. */
export const IconList = (p: P) => (
  <svg {...base} {...p}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none" /></svg>
);
export const IconEye = (p: P) => (
  <svg {...base} {...p}><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.8" /></svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base} {...p}><path d="M10.6 6.2A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a18 18 0 0 1-3.2 4" /><path d="M6.5 7.9A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5a9.8 9.8 0 0 0 4-.86" /><path d="M9.9 9.9a2.8 2.8 0 0 0 3.9 3.9" /><path d="m3 3 18 18" /></svg>
);
/** An envelope being searched: read the mail already in the system. */
export const IconMailScan = (p: P) => (
  <svg {...base} {...p}><path d="M21 11.5V6H3v12h8.5" /><path d="m3 7 9 6 9-6" /><circle cx="17.5" cy="17.5" r="3" /><path d="m20 20 2 2" /></svg>
);
export const IconCalendar = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="5" width="18" height="16" rx="1.5" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
);
export const IconChevronLeft = (p: P) => (
  <svg {...base} {...p}><path d="m15 6-6 6 6 6" /></svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...base} {...p}><path d="m9 6 6 6-6 6" /></svg>
);
