import { inflateRawSync } from 'node:zlib';

/**
 * Reading a workbook, without a library.
 *
 * The studio's schedules are spreadsheets: the flooring install schedule,
 * the FF&E list, a vendor's quote. Until now nothing in the app could open
 * one — `readDocument` takes PDFs and images, and `readDriveText` exports
 * only Google-native Sheets — so Jenny could find a schedule, name it and
 * hand it over, but never say what was in it. She answered "the finishes
 * are listed in the Finish Schedule" while holding the Finish Schedule.
 *
 * An .xlsx is a zip of XML, and the part of it that holds cell values is
 * small and well defined. That is cheaper than a dependency and matches how
 * the rest of this codebase talks to formats it does not own: read exactly
 * what is needed, and be honest about the rest.
 *
 * What it does NOT do: formulas (the cached value is returned, which is
 * what was last calculated), formatting, merged-cell geometry, or date
 * formatting — an Excel date is a number here, and is left as one rather
 * than guessed at.
 */

/** A workbook past this is a database, not a schedule. Read the front of it. */
const MAX_ROWS = 400;
const MAX_COLS = 40;

/** The entries of a zip, by name. Returns null if this is not a zip at all. */
export function unzip(file: Buffer): Map<string, Buffer> | null {
  // The end-of-central-directory record is last, but may be followed by a
  // comment, so it is searched for backwards from the end.
  let eocd = -1;
  for (let i = file.length - 22; i >= 0 && i > file.length - 22 - 65_536; i--) {
    if (file.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = file.readUInt16LE(eocd + 10);
  let at = file.readUInt32LE(eocd + 16);
  const found = new Map<string, Buffer>();

  for (let n = 0; n < entryCount; n++) {
    if (at + 46 > file.length || file.readUInt32LE(at) !== 0x02014b50) break;
    const method = file.readUInt16LE(at + 10);
    const compressedSize = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const localAt = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    // The local header repeats the name and extra fields, and only it knows
    // their real lengths — the central directory's copy can differ.
    if (localAt + 30 <= file.length && file.readUInt32LE(localAt) === 0x04034b50) {
      const localNameLength = file.readUInt16LE(localAt + 26);
      const localExtraLength = file.readUInt16LE(localAt + 28);
      const dataAt = localAt + 30 + localNameLength + localExtraLength;
      const raw = file.subarray(dataAt, dataAt + compressedSize);
      try {
        found.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
      } catch {
        // One unreadable part should not lose the whole workbook.
      }
    }
    at += 46 + nameLength + extraLength + commentLength;
  }

  return found.size ? found : null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? whole;
  });
}

/** Every `<t>` inside a chunk, joined — a rich-text cell is split across runs. */
function textOf(chunk: string): string {
  const parts: string[] = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) parts.push(decodeXml(m[1]));
  return parts.join('');
}

/** The shared string table: cells reference these by index rather than repeat them. */
function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) strings.push(m[1] ? textOf(m[1]) : '');
  return strings;
}

/** "BC" → 54. Column letters, so a blank cell keeps its place in the row. */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(xml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(xml)) && rows.length < MAX_ROWS) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      let value = '';
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        value = strings[index] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        // `str` is a formula's cached string; anything else is a number or
        // a boolean, and is passed through as written.
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      const column = ref ? columnIndex(ref) : cells.length;
      if (column >= MAX_COLS) continue;
      while (cells.length < column) cells.push('');
      cells[column] = value.replace(/\s+/g, ' ').trim();
    }

    // Trailing blanks carry nothing; an entirely blank row is a spacer.
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length) rows.push(cells);
  }

  return rows;
}

export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

/** Whether this is a file this reader can open, by type or by name. */
export function isWorkbook(mimeType: string, name = ''): boolean {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    /\.xlsx?$/i.test(name)
  );
}

/**
 * The sheets of a workbook, in the order the workbook lists them.
 *
 * Returns null when the bytes are not a workbook this can open — the caller
 * then hands the file over rather than pretending to have read it.
 */
export function readWorkbook(bytes: Buffer): WorkbookSheet[] | null {
  const zip = unzip(bytes);
  if (!zip) return null;

  const strings = sharedStrings(zip.get('xl/sharedStrings.xml')?.toString('utf8'));

  // Names live in the workbook part, in the same order as the sheet files
  // they point at. Falling back to "Sheet 1" keeps a damaged workbook
  // readable rather than nameless.
  const workbook = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const names = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));

  const sheetPaths = [...zip.keys()]
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));

  const sheets: WorkbookSheet[] = [];
  for (const [i, path] of sheetPaths.entries()) {
    const rows = sheetRows(zip.get(path)!.toString('utf8'), strings);
    if (rows.length) sheets.push({ name: names[i] ?? `Sheet ${i + 1}`, rows });
  }

  return sheets.length ? sheets : null;
}

/**
 * A workbook as text a model can read.
 *
 * Tab-separated, because a schedule's cells contain commas — "12in x 24in,
 * staggered" is one value — and a comma-separated rendering of that reads
 * as two columns to anything downstream.
 */
/** Whether this is a Word document, by type or by name. */
export function isDocument(mimeType: string, name = ''): boolean {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(name)
  );
}

/**
 * The words of a .docx.
 *
 * Same container as a workbook — a zip of XML — so the same reader opens
 * it. Paragraphs become lines and tables become tab-separated rows, which
 * is all a model needs: a specification reads the same whether or not it
 * knows what was bold.
 */
export function documentText(bytes: Buffer, maxChars = 12_000): string | null {
  const zip = unzip(bytes);
  const xml = zip?.get('word/document.xml')?.toString('utf8');
  if (!xml) return null;

  /** Word's own text runs are `<w:t>`, not the `<t>` a workbook uses. */
  const wordText = (chunk: string): string => {
    const parts: string[] = [];
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk))) parts.push(decodeXml(m[1]));
    return parts.join('');
  };

  const lines: string[] = [];

  // Rows are matched BEFORE paragraphs, and a row swallows the paragraphs
  // inside its cells. Splitting on `</w:p>` first would tear a table row
  // into one line per cell, which turns a schedule back into a list.
  const blocks = /<w:tr\b[\s\S]*?<\/w:tr>|<w:p\b[\s\S]*?<\/w:p>/g;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(xml))) {
    const chunk = block[0];
    if (chunk.startsWith('<w:tr')) {
      const cells = chunk.split(/<\/w:tc>/).map((cell) => wordText(cell).trim()).filter(Boolean);
      if (cells.length) lines.push(cells.join('\t'));
      continue;
    }
    const line = wordText(chunk).replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }

  const text = lines.join('\n');
  if (!text.trim()) return null;
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… (truncated — the document is longer than can be read at once)`
    : text;
}

export function workbookText(bytes: Buffer, maxChars = 12_000): string | null {
  const sheets = readWorkbook(bytes);
  if (!sheets) return null;

  const out: string[] = [];
  for (const sheet of sheets) {
    out.push(`--- Sheet: ${sheet.name} (${sheet.rows.length} rows) ---`);
    for (const row of sheet.rows) out.push(row.join('\t'));
    out.push('');
  }

  const text = out.join('\n');
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… (truncated — the workbook is longer than can be read at once)`
    : text;
}
