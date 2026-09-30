/**
 * A picture Jenny drew, saved in the format someone needs.
 *
 * What comes back from the server is one file — an SVG or a PNG, depending on
 * who drew it — but a client wants a PDF to send, a JPG to attach, a PNG to
 * place in a deck. The conversion is done here, in the browser, so it costs
 * the server nothing and works on whatever was already fetched:
 *
 *   PNG / JPG / JPEG — drawn onto a canvas and encoded (JPEG on white, as it
 *                      has no transparency).
 *   SVG              — the vector itself when that is what was drawn;
 *                      otherwise the raster wrapped in an SVG.
 *   PDF              — one page the shape of the picture, holding it as a
 *                      JPEG. Written by hand: a single image on a single
 *                      page needs no library.
 */

export type ExportFormat = 'png' | 'jpg' | 'jpeg' | 'pdf' | 'svg';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: 'png', label: 'PNG', note: 'Lossless, for decks and print' },
  { id: 'jpg', label: 'JPG', note: 'Smaller, for email' },
  { id: 'jpeg', label: 'JPEG', note: 'Same as JPG, .jpeg extension' },
  { id: 'pdf', label: 'PDF', note: 'One page, to send to a client' },
  { id: 'svg', label: 'SVG', note: 'Vector, scales without blurring' },
];

/** The longest side a raster export is drawn at — past this a canvas fails on many devices. */
const MAX_SIDE = 4096;

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
};

function decode(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This picture could not be read.'));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be converted.'))), type, quality),
  );
}

/** The picture on a canvas, white behind it, no larger than MAX_SIDE. */
async function rasterise(source: Blob): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const img = await decode(source);
  // An SVG with no size of its own reports 0; give it something drawable.
  const naturalW = img.naturalWidth || 1600;
  const naturalH = img.naturalHeight || 1000;
  const scale = Math.min(1, MAX_SIDE / Math.max(naturalW, naturalH));
  const width = Math.max(1, Math.round(naturalW * scale));
  const height = Math.max(1, Math.round(naturalH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot convert the picture.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { canvas, width, height };
}

const text = (s: string) => new TextEncoder().encode(s);

/** One page, sized to the picture, holding a JPEG. */
export function pdfWithJpeg(jpeg: Uint8Array, width: number, height: number): Blob {
  // Points, scaled so the longer side is a comfortable 792pt (11in); the
  // picture fills the page, so there is nothing to crop or letterbox.
  const scale = 792 / Math.max(width, height);
  const pw = +(width * scale).toFixed(2);
  const ph = +(height * scale).toFixed(2);
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;

  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array) => {
    parts.push(chunk);
    length += chunk.length;
  };
  const object = (n: number, head: string, stream?: Uint8Array) => {
    offsets[n] = length;
    push(text(`${n} 0 obj\n${head}\n`));
    if (stream) {
      push(text('stream\n'));
      push(stream);
      push(text('\nendstream\n'));
    }
    push(text('endobj\n'));
  };

  push(text('%PDF-1.4\n'));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  object(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  object(5, `<< /Length ${content.length} >>`, text(content));

  const xref = length;
  let table = `xref\n0 6\n0000000000 65535 f \n`;
  for (let n = 1; n <= 5; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(text(`${table}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

  return new Blob(parts as BlobPart[], { type: MIME.pdf });
}

/**
 * Convert a fetched picture into the chosen format. `sourceType` is what the
 * bytes are ('image/svg+xml' or a raster type); `baseName` has no extension.
 */
export async function exportImage(
  source: Blob,
  sourceType: string,
  format: ExportFormat,
  baseName: string,
): Promise<{ blob: Blob; filename: string }> {
  const typed = new Blob([source], { type: sourceType });
  const filename = `${baseName}.${format}`;
  const isSvg = sourceType.includes('svg');

  if (format === 'svg') {
    if (isSvg) return { blob: typed, filename };
    // A raster has no vector to give; wrap it so the file is still a valid SVG.
    const { canvas, width, height } = await rasterise(typed);
    const png = await toBlob(canvas, 'image/png');
    const bytes = new Uint8Array(await png.arrayBuffer());
    let binary = '';
    // In slices: spreading a whole picture into one call overflows the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(binary);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><image href="data:image/png;base64,${b64}" xlink:href="data:image/png;base64,${b64}" width="${width}" height="${height}"/></svg>`;
    return { blob: new Blob([svg], { type: MIME.svg }), filename };
  }

  const { canvas, width, height } = await rasterise(typed);
  if (format === 'png') return { blob: await toBlob(canvas, 'image/png'), filename };
  if (format === 'jpg' || format === 'jpeg') return { blob: await toBlob(canvas, 'image/jpeg', 0.92), filename };

  const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
  return { blob: pdfWithJpeg(jpeg, width, height), filename };
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
