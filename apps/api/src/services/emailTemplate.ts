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

/** The light-theme tokens, written out — a mail client cannot read our CSS. */
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
          <td style="padding:0 4px 20px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="width:40px;height:40px;background:${C.brass};border-radius:10px;text-align:center;vertical-align:middle;font-family:${FONT};font-size:20px;font-weight:700;color:#ffffff;line-height:40px;">J</td>
                <td style="padding-left:12px;font-family:${FONT};">
                  <div style="font-size:16px;font-weight:600;color:${C.ink};line-height:1.2;">Janelle Interiors</div>
                  <div style="font-size:12px;color:${C.inkFaint};line-height:1.4;">Workflow System</div>
                </td>
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
