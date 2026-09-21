/**
 * Making an attachment readable before it is sent.
 *
 * The server judges a file by its first bytes, not by its name, and it can
 * only hand four image types to a model: PNG, JPEG, GIF and WebP. Plenty of
 * pictures people actually have are none of those — a phone photo is HEIC,
 * an AI export is often AVIF or WebP saved under a .png name, a board this
 * app rendered itself comes back as SVG. All of them look like images in
 * the file picker, and all of them were refused with a line that said they
 * were not images at all.
 *
 * So anything the browser can DISPLAY is re-encoded here before it goes.
 * The browser already has the decoders; this just puts the result into a
 * format the rest of the chain accepts. What the browser cannot decode
 * either (HEIC on Windows, say) is refused by name, which at least tells
 * someone what to do about it.
 */

/** Pictures the server takes as they are; anything else pictorial is converted. */
const READABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Not pictures at all, and not to be rasterised.
 *
 * A schedule, a spec or a quote is read as text on the server. Sending one
 * through the canvas would turn a readable workbook into a blank PNG.
 */
const DOCUMENTS = /\.(pdf|xlsx?|docx?|csv|tsv|txt|md)$/i;

/** Longest side of a converted picture. Enough for a plan, small enough to send. */
const MAX_SIDE = 2048;

/** Past this a PNG is re-encoded as JPEG; a phone photo is not worth 20MB. */
const PNG_CEILING = 6 * 1024 * 1024;

/** The type from the first bytes, exactly as the server reads them. */
export async function sniffFile(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));

  if (head.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';

  // ISO base media: AVIF and HEIC share this wrapper with MP4, and only the
  // brand that follows tells them apart.
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
    return 'video/mp4';
  }

  const text = new TextDecoder().decode(head).trimStart();
  if (/^(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return 'image/svg+xml';
  return null;
}

/** A name for a type, for a refusal someone can act on. */
function nameOf(type: string | null, file: File): string {
  const called: Record<string, string> = {
    'image/heic': 'a HEIC photo',
    'image/avif': 'an AVIF image',
    'image/svg+xml': 'an SVG drawing',
    'video/mp4': 'a video',
  };
  if (type && called[type]) return called[type];
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1];
  return ext ? `a .${ext.toLowerCase()} file` : 'that file';
}

/** Draw whatever was decoded, bounded, and encode it as something readable. */
async function encode(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not convert the picture.');
  // An SVG or a transparent PNG would otherwise land on black once it is
  // flattened into a JPEG.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const toBlob = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

  const png = await toBlob('image/png');
  if (png && png.size <= PNG_CEILING) return png;
  const jpeg = await toBlob('image/jpeg', 0.92);
  if (jpeg) return jpeg;
  if (png) return png;
  throw new Error('This browser could not convert the picture.');
}

/**
 * An SVG the browser will agree to rasterise.
 *
 * `createImageBitmap` refuses a source with "no intrinsic dimensions", and
 * a percentage width is exactly that — which is what the boards this app
 * renders itself come back as: the vector prompt fixes a viewBox and says
 * nothing about width or height, so the model writes `width="100%"`. The
 * viewBox already carries the real size, so it is copied onto the element.
 *
 * The type is set explicitly too: a blob URL is rendered according to its
 * type, and a file whose type the OS reported as empty would not load as
 * an image at all.
 */
async function sizedSvg(file: File): Promise<Blob> {
  const text = await file.text();
  const box = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
  const [, , boxWidth, boxHeight] = (box ?? '').trim().split(/[\s,]+/).map(Number);
  const width = Number.isFinite(boxWidth) && boxWidth > 0 ? boxWidth : 1600;
  const height = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight : 1000;

  const sized = text.replace(
    /<svg\b([^>]*)>/i,
    (_whole, attrs: string) =>
      `<svg${attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '')} width="${width}" height="${height}">`,
  );
  return new Blob([sized], { type: 'image/svg+xml' });
}

/** Decode with the browser's own decoders, whichever path works. */
async function decode(file: File, type: string | null): Promise<Blob> {
  // Markup needs fixing before any decoder will look at it; everything
  // else is handed over as it arrived.
  const source: Blob = type === 'image/svg+xml' ? await sizedSvg(file) : file;

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(source);
      try {
        return await encode(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close?.();
      }
    } catch {
      // Falls through: an <img> handles some formats (SVG most of all)
      // that createImageBitmap refuses.
    }
  }

  const url = URL.createObjectURL(source);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('undecodable'));
      el.src = url;
    });
    // An SVG with no width/height has no intrinsic size to draw at.
    const width = img.naturalWidth || 1024;
    const height = img.naturalHeight || 1024;
    return await encode(img, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class AttachmentError extends Error {}

/**
 * The file to actually upload — the original when it is already readable,
 * a converted PNG or JPEG when it is not.
 *
 * Throws an AttachmentError naming the format when nothing can be done
 * with it, so the chip says "that is a HEIC photo" rather than "not an
 * image".
 */
export async function readableAttachment(file: File): Promise<File> {
  const type = await sniffFile(file);

  if (type === 'application/pdf' || (type && READABLE.has(type))) return file;

  // Documents go up untouched — the server reads their contents, and a
  // picture of a spreadsheet is no use to anybody.
  if (DOCUMENTS.test(file.name) && type !== 'image/svg+xml') return file;

  if (type === 'video/mp4') {
    throw new AttachmentError('Jenny cannot read a video. Attach a still from it instead.');
  }

  try {
    const converted = await decode(file, type);
    const extension = converted.type === 'image/jpeg' ? 'jpg' : 'png';
    const stem = file.name.replace(/\.[a-z0-9]+$/i, '') || 'image';
    return new File([converted], `${stem}.${extension}`, { type: converted.type });
  } catch {
    throw new AttachmentError(
      `${nameOf(type, file)} — this browser cannot open it to convert. Save it as a PNG or JPEG first.`,
    );
  }
}
