import { env } from '../env.js';
/**
 * The studio's email, as mail clients actually render it.
 *
 * Email is not the web. Outlook lays out with Word, which knows nothing of
 * flexbox or grid; most clients strip a `<style>` block; several rewrite
 * colours for dark mode. So everything here is a nested table with inline
 * styles and explicit colours — the dull answer, and the only one that
 * survives Outlook, Gmail, Apple Mail and a phone alike.
 *
 * Every message goes out as both HTML and plain text (see `sendMessage`).
 * The text half is not a fallback nobody reads: it is what a screen reader,
 * a watch, and a spam filter all judge the mail on.
 */

/**
 * The light-theme tokens, written out — a mail client cannot read our CSS.
 * Same values as `--brass` / `--good` / `--warn` / `--crit` in
 * apps/web/src/styles/index.css (light mode), so a task's colour means the
 * same thing here as it does on the board.
 */
const C = {
  brass: '#4DBC15',
  brassDeep: '#3A9A0C',
  ink: '#1F2327',
  inkSoft: '#5A6169',
  inkFaint: '#8D949C',
  surface: '#FFFFFF',
  paper: '#F4F5F7',
  line: '#DFE2E6',
  sunk: '#EEF0F2',
  good: '#2E9E3A',
  warn: '#D98A1F',
  crit: '#D63A2F',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace";

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

/**
 * A greeting that does not read as a database field.
 *
 * The name may be a real one ("Brianna Johnson"), or the local part of an
 * address standing in for one ("denish123"), because that is what is stored
 * when somebody is added without a name. Addressing a person as their login
 * is worse than not addressing them at all.
 */
function greeting(name: string): string {
  const clean = (name ?? '').trim();
  if (!clean) return 'Hello,';
  const first = clean.split(/\s+/)[0];
  // Digits, dots or underscores mean this came from an address, not a person.
  if (/[0-9._]/.test(first) || first.length < 2) return 'Hello,';
  return `Hi ${first.charAt(0).toUpperCase()}${first.slice(1)},`;
}

/**
 * The header mark. The studio's logo when the app's address is known — mail
 * clients only show an image they can fetch, so it is served from the app's
 * own public folder — and the plain monogram otherwise.
 */
function logoCell(): string {
  const base = (env.appUrl ?? '').replace(/\/+$/, '');
  if (base) {
    return `<td style="font-family:${FONT};"><img src="${base}/logo-email.png" width="150" alt="Janelle Interiors" style="display:block;width:150px;height:auto;border:0;outline:none;"></td>`;
  }
  return `<td style="width:40px;height:40px;background:${C.brass};border-radius:10px;text-align:center;vertical-align:middle;font-family:${FONT};font-size:20px;font-weight:700;color:#ffffff;line-height:40px;">J</td>
                <td style="padding-left:12px;font-family:${FONT};">
                  <div style="font-size:16px;font-weight:600;color:${C.ink};line-height:1.2;">Janelle Interiors</div>
                  <div style="font-size:12px;color:${C.inkFaint};line-height:1.4;">Workflow System</div>
                </td>`;
}

function shell(preheader: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Janelle Interiors</title>
</head>
<body style="margin:0;padding:0;background:${C.paper};">
<!-- The line a phone shows beside the subject. Hidden in the message itself;
     without it the preview is whatever the first words happen to be. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
  ${preheader}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
        <tr>
          <td align="center" style="padding:0 4px 20px 4px;">
            <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                ${logoCell()}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:${C.surface};border:1px solid ${C.line};border-radius:14px;padding:32px;font-family:${FONT};">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 8px 0 8px;font-family:${FONT};font-size:11.5px;line-height:1.6;color:${C.inkFaint};">
            Sent by the Janelle Interiors workflow system.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  // A padded anchor rather than a VML shape: it renders as a button
  // everywhere that matters and degrades to a plain link where it does not.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px 0;">
  <tr>
    <td style="background:${C.brass};border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a>
    </td>
  </tr>
</table>`;
}

function row(label: string, value: string, mono = false): string {
  return `<tr>
  <td style="padding:10px 14px;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:12px;color:${C.inkFaint};white-space:nowrap;vertical-align:top;width:86px;">${label}</td>
  <td style="padding:10px 14px;border-bottom:1px solid ${C.line};font-family:${mono ? MONO : FONT};font-size:${mono ? '15px' : '14px'};${mono ? 'letter-spacing:0.5px;font-weight:600;' : ''}color:${C.ink};word-break:break-all;">${value}</td>
</tr>`;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The welcome a new teammate gets, with the password they sign in on. */
export function inviteEmail(opts: { name: string; email: string; password: string; url: string }): Mail {
  const hi = greeting(opts.name);
  const email = escape(opts.email);
  const password = escape(opts.password);
  const url = escape(opts.url);

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:14px;font-size:14px;line-height:1.65;color:${C.inkSoft};">
  You have an account on the Janelle Interiors workflow system. It keeps track of projects,
  tasks, vendor orders and the studio mailbox, so nothing gets lost between emails.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border:1px solid ${C.line};border-radius:10px;background:${C.sunk};">
  <tr>
    <td colspan="2" style="padding:12px 14px 4px 14px;font-family:${FONT};font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${C.inkFaint};">
      Your sign-in
    </td>
  </tr>
  ${row('Email', email)}
  ${row('Password', password, true)}
</table>

${button(url, 'Open the workflow system')}

<div style="font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  Or paste this into your browser: <span style="color:${C.brassDeep};">${url}</span>
</div>

<div style="margin-top:24px;padding:12px 14px;border-left:3px solid ${C.brass};background:${C.sunk};border-radius:0 8px 8px 0;font-size:13px;line-height:1.6;color:${C.inkSoft};">
  <strong style="color:${C.ink};">Please change this password once you are in.</strong>
  It was generated for you and sent by email, so it should not stay in use —
  open <strong>Settings</strong> and use the Password panel.
</div>

<div style="margin-top:24px;padding-top:18px;border-top:1px solid ${C.line};font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  If you were not expecting this, you can ignore it and nothing will happen.
</div>`;

  const text = [
    hi,
    '',
    'You have an account on the Janelle Interiors workflow system. It keeps track of',
    'projects, tasks, vendor orders and the studio mailbox, so nothing gets lost',
    'between emails.',
    '',
    'YOUR SIGN-IN',
    `  Email:    ${opts.email}`,
    `  Password: ${opts.password}`,
    '',
    `Sign in here: ${opts.url}`,
    '',
    'Please change this password once you are in. It was generated for you and sent',
    'by email, so it should not stay in use — open Settings and use the Password panel.',
    '',
    'If you were not expecting this, you can ignore it and nothing will happen.',
    '',
    '—',
    'Sent by the Janelle Interiors workflow system.',
  ].join('\n');

  return {
    subject: 'Your Janelle Interiors workflow account',
    text,
    html: shell('Your sign-in details for the Janelle Interiors workflow system.', body),
  };
}

// ── The task reminders: a morning plan and an evening wrap-up ───────

/**
 * Two emails a day, for two different jobs.
 *
 *   morning  what to do today: whatever was left unfinished from earlier days,
 *            and what is due today.
 *   evening  how the day went: what got done, what is still pending, and what
 *            is due tomorrow — so tomorrow starts from a list, not from memory.
 */
export type ReminderSlot = 'morning' | 'evening';

/** How late (or not) a task reads, and the colour that says so. */
export type DueTone = 'crit' | 'warn' | 'neutral' | 'faint' | 'good';

const TONE_COLOR: Record<DueTone, string> = {
  crit: C.crit,
  warn: C.warn,
  neutral: C.inkSoft,
  faint: C.inkFaint,
  good: C.good,
};

export interface MiddayTaskRow {
  title: string;
  /** Design, FF&E, Procurement & shipping or Admin & operations. */
  category: string;
  /** Project or vendor context, when there is one. */
  project: string | null;
  /** Already phrased for reading, e.g. "overdue, was due Sep 20", "due today" or "completed today". */
  dueText: string;
  /** crit: carried over from an earlier day. warn: due today. neutral: due tomorrow. good: finished today. */
  tone: DueTone;
  blocked: boolean;
}

export interface MiddayGroup {
  /** The kind of work, upper-cased: "DESIGN", "FF&E", "PROCUREMENT & SHIPPING", "ADMIN & OPERATIONS". */
  label: string;
  rows: MiddayTaskRow[];
}

/** What is in a set of groups, by what the row's colour says it is. */
function tally(groups: MiddayGroup[]): { carried: number; today: number; tomorrow: number; done: number } {
  const rows = groups.flatMap((g) => g.rows);
  const n = (tone: DueTone) => rows.filter((r) => r.tone === tone).length;
  return { carried: n('crit'), today: n('warn'), tomorrow: n('neutral'), done: n('good') };
}

function taskRowHtml(t: MiddayTaskRow): string {
  const color = TONE_COLOR[t.tone];
  const meta = [t.project, t.dueText].filter((s): s is string => !!s).map(escape).join(' · ');
  const done = t.tone === 'good';
  return `<tr>
  <td style="padding:9px 0;border-bottom:1px solid ${C.line};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="width:14px;vertical-align:top;padding-top:6px;">
          <div style="width:6px;height:6px;border-radius:50%;background:${color};"></div>
        </td>
        <td style="font-family:${FONT};">
          <div style="font-size:13.5px;font-weight:600;color:${done ? C.inkSoft : C.ink};line-height:1.4;${
    done ? 'text-decoration:line-through;' : ''
  }">${escape(t.title)}${t.blocked ? ` <span style="color:${C.crit};font-weight:700;text-decoration:none;">· blocked</span>` : ''}</div>
          <div style="margin-top:1px;font-size:12px;color:${color};line-height:1.5;">${done ? '✓ ' : ''}${meta}</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function taskRowText(t: MiddayTaskRow): string {
  const meta = [t.project, t.dueText].filter(Boolean).join(' — ');
  return `  ${t.tone === 'good' ? '[x]' : '- '} ${t.title}${meta ? ` (${meta})` : ''}${t.blocked ? ' [blocked]' : ''}`;
}

function groupHtml(g: MiddayGroup): string {
  if (!g.rows.length) return '';
  return `<div style="margin-top:16px;">
  <div style="font-family:${FONT};font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${C.inkFaint};padding-bottom:2px;">
    ${escape(g.label)} <span style="font-weight:600;">(${g.rows.length})</span>
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${g.rows.map(taskRowHtml).join('')}
  </table>
</div>`;
}

function groupText(g: MiddayGroup): string {
  if (!g.rows.length) return '';
  return `${g.label} (${g.rows.length})\n${g.rows.map(taskRowText).join('\n')}`;
}

/** Every group in `groups` that has at least one row, rendered as HTML. */
function groupsHtml(groups: MiddayGroup[]): string {
  return groups.map(groupHtml).join('');
}

function groupsText(groups: MiddayGroup[]): string {
  return groups
    .filter((g) => g.rows.length)
    .map(groupText)
    .join('\n\n');
}

/** Total tasks across every group. */
function countOf(groups: MiddayGroup[]): number {
  return groups.reduce((n, g) => n + g.rows.length, 0);
}

/** The sentence under the greeting, and what it promises the email holds. */
function intro(slot: ReminderSlot, scope: 'yours' | 'studio'): string {
  const who = scope === 'yours' ? '' : ' across the studio';
  return slot === 'morning'
    ? `Good morning — here is what was left unfinished from earlier days and what is due today${who}, grouped by kind of work.`
    : `Here is how today went${who}: what got done, what is still pending, and what is due tomorrow — grouped by kind of work.`;
}

/** One line for a subject or a card: the numbers that matter at this time of day. */
function headline(slot: ReminderSlot, groups: MiddayGroup[]): string {
  const t = tally(groups);
  const pending = t.carried + t.today;
  if (slot === 'morning') {
    return `${pending} to do today${t.carried ? `, ${t.carried} carried over` : ''}`;
  }
  return `${t.done} done, ${pending} pending${t.tomorrow ? `, ${t.tomorrow} due tomorrow` : ''}`;
}

/** Each teammate's own reminder. */
export function middayPersonalEmail(opts: { name: string; slot: ReminderSlot; groups: MiddayGroup[]; boardUrl?: string }): Mail {
  const hi = greeting(opts.name);
  const lead = intro(opts.slot, 'yours');
  const line = headline(opts.slot, opts.groups);

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:10px;font-size:14px;line-height:1.6;color:${C.inkSoft};">
  ${escape(lead)}
</div>

${groupsHtml(opts.groups)}
${opts.boardUrl ? button(opts.boardUrl, 'Open the task board') : ''}`;

  const text = [
    hi,
    '',
    lead,
    '',
    groupsText(opts.groups),
    opts.boardUrl ? `\nOpen the task board: ${opts.boardUrl}` : '',
    '',
    '—',
    'Sent by the Janelle Interiors workflow system.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    subject: `${opts.slot === 'morning' ? 'Today’s tasks' : 'Evening wrap-up'} — ${line}`,
    text,
    html: shell(line, body),
  };
}

/** The owner's copy: the whole studio, one card per person. */
export function middayOwnerEmail(opts: {
  name: string;
  slot: ReminderSlot;
  people: { name: string; groups: MiddayGroup[] }[];
  unassigned: MiddayGroup[];
  boardUrl?: string;
}): Mail {
  const hi = greeting(opts.name);
  const lead = intro(opts.slot, 'studio');
  const everyone = [...opts.people.flatMap((p) => p.groups), ...opts.unassigned];
  const line = headline(opts.slot, everyone);

  const personCard = (name: string, groups: MiddayGroup[]): string => {
    const t = tally(groups);
    const parts =
      opts.slot === 'morning'
        ? [
            t.carried ? `<span style="color:${C.crit};font-weight:600;">${t.carried} carried over</span>` : '',
            t.today ? `<span style="color:${C.warn};font-weight:600;">${t.today} today</span>` : '',
          ]
        : [
            t.done ? `<span style="color:${C.good};font-weight:600;">${t.done} done</span>` : '',
            t.carried + t.today ? `<span style="color:${C.warn};font-weight:600;">${t.carried + t.today} pending</span>` : '',
            t.tomorrow ? `${t.tomorrow} tomorrow` : '',
          ];
    const summary = parts.filter(Boolean).join(' &middot; ');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;border:1px solid ${C.line};border-radius:10px;">
  <tr>
    <td style="background:${C.sunk};padding:10px 14px;border-radius:10px 10px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:${FONT};font-size:13.5px;font-weight:700;color:${C.ink};">${escape(name)}</td>
          <td align="right" style="font-family:${FONT};font-size:11.5px;color:${C.inkFaint};white-space:nowrap;">${summary}</td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:2px 14px 12px 14px;">
      ${groupsHtml(groups)}
    </td>
  </tr>
</table>`;
  };

  const cards = [
    ...opts.people.map((p) => personCard(p.name, p.groups)),
    countOf(opts.unassigned) ? personCard('Unassigned', opts.unassigned) : '',
  ]
    .filter(Boolean)
    .join('');

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:10px;font-size:14px;line-height:1.6;color:${C.inkSoft};">
  ${escape(lead)}
</div>

${cards}
${opts.boardUrl ? button(opts.boardUrl, 'Open the task board') : ''}`;

  const personText = (name: string, groups: MiddayGroup[]): string => `${name.toUpperCase()} (${countOf(groups)})\n${groupsText(groups)}`;
  const text = [
    hi,
    '',
    lead,
    '',
    [
      ...opts.people.map((p) => personText(p.name, p.groups)),
      countOf(opts.unassigned) ? personText('Unassigned', opts.unassigned) : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    opts.boardUrl ? `\nOpen the task board: ${opts.boardUrl}` : '',
    '',
    '—',
    'Sent by the Janelle Interiors workflow system.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    subject: `${opts.slot === 'morning' ? 'Team plan for today' : 'Team wrap-up'} — ${line}`,
    text,
    html: shell(line, body),
  };
}
