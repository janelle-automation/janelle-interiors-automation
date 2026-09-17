import { Fragment, type ReactNode } from 'react';

/**
 * Claude answers in Markdown. Printing it verbatim put "# Concept Narrative"
 * and "**Natural oak**" on the screen — the punctuation of the format instead
 * of the document it describes.
 *
 * Hand-written rather than pulled from a package for the same reason
 * `decodeEntities` is: the shapes these prompts actually return are a short
 * list — headings, bold, lists, rules, the occasional schedule table — and a
 * renderer for exactly those is smaller than the dependency, carries no
 * `dangerouslySetInnerHTML`, and cannot render anything the parser did not
 * itself recognise.
 */

// ── Inline ──────────────────────────────────────────────────

// Ordered so the greedier markers win: ** before *, and code before both,
// since a backticked span is literal and must not be re-parsed.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;

  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyBase}-${m.index}`;

    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-sunk px-1 py-0.5 text-[0.92em] text-ink-soft">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key} className="font-semibold text-ink">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      // Model-written links point outward; they never navigate the app.
      out.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="focusable text-brass-deep underline underline-offset-2"
        >
          {label}
        </a>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── Blocks ──────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^\s*```/;

/** A row of a table, minus its outer pipes. */
function cells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/** The `---|:--:|---` line under a table's header, which marks it as one. */
function isDivider(line: string | undefined): boolean {
  return !!line && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

const HEADING_CLASS = [
  'mt-5 text-[17px] font-semibold text-ink first:mt-0',
  'mt-5 text-[15.5px] font-semibold text-ink first:mt-0',
  'mt-4 text-[14px] font-semibold text-ink first:mt-0',
  'mt-4 text-[13.5px] font-semibold text-ink first:mt-0',
  'mt-3 text-[13px] font-semibold text-ink-soft first:mt-0',
  'mt-3 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint first:mt-0',
];

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code — taken literally to the closing fence, or to the end of
    // the answer when the model never closed it.
    if (FENCE.test(line)) {
      const start = ++i;
      while (i < lines.length && !FENCE.test(lines[i])) i++;
      blocks.push(
        <pre key={`code${start}`} className="mt-3 overflow-x-auto rounded-lg bg-sunk px-3 py-2.5 text-[12.5px] text-ink-soft">
          {lines.slice(start, i).join('\n')}
        </pre>,
      );
      i++; // past the closing fence
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 1, 6)}` as 'h2';
      blocks.push(
        <Tag key={`h${i}`} className={HEADING_CLASS[level - 1]}>{inline(heading[2], `h${i}`)}</Tag>,
      );
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={`hr${i}`} className="my-4 border-line-soft" />);
      i++;
      continue;
    }

    // Table: a pipe row whose next line is the divider.
    if (line.includes('|') && isDivider(lines[i + 1])) {
      const header = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(cells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`t${i}`} className="mt-3 overflow-x-auto rounded-lg border border-line-soft">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line-soft bg-sunk/50 text-left text-ink-faint">
                {header.map((h, n) => (
                  <th key={n} className="px-3 py-2 font-semibold">{inline(h, `th${n}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {body.map((row, r) => (
                <tr key={r} className="text-ink-soft">
                  {header.map((_, c) => (
                    <td key={c} className="px-3 py-2 align-top">{inline(row[c] ?? '', `td${r}-${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lists. A run of items of the same kind becomes one list; a nested
    // item (indented two or more spaces) is drawn indented rather than
    // opening a second list, which is enough for what these answers hold.
    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = NUMBER.test(line) && !BULLET.test(line);
      const items: { depth: number; body: string }[] = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const n = NUMBER.exec(lines[i]);
        if (!b && !n) break;
        if ((ordered && !n && b) || (!ordered && n && !b)) break;
        const indent = (b ? b[1] : n![1]).length;
        items.push({ depth: indent >= 2 ? 1 : 0, body: b ? b[2] : n![3] });
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List
          key={`l${i}`}
          className={`mt-2 space-y-1 ${ordered ? 'list-decimal' : 'list-disc'} pl-5 marker:text-ink-faint`}
        >
          {items.map((it, n) => (
            <li key={n} className={it.depth ? 'ml-5' : ''}>{inline(it.body, `li${n}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const start = i;
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      blocks.push(
        <blockquote key={`q${start}`} className="mt-3 border-l-2 border-brass/40 pl-3 text-ink-soft">
          {quoted.join(' ')}
        </blockquote>,
      );
      continue;
    }

    // Paragraph: everything up to a blank line or the next block opener.
    const start = i;
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !RULE.test(lines[i])
           && !BULLET.test(lines[i]) && !NUMBER.test(lines[i]) && !QUOTE.test(lines[i]) && !FENCE.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`p${start}`} className="mt-3 first:mt-0">
        {para.map((l, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(l, `p${start}-${n}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className={className}>{blocks}</div>;
}
