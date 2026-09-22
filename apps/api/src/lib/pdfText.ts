/**
 * The words on each page of a PDF, without reading it with a model.
 *
 * A studio plan set is forty or sixty pages of pictures at close to a
 * megabyte each; sending all of it to be read, to find the one page that is
 * the flooring plan, cost a 45MB upload that timed out and the answer "too
 * large". The page titles, the schedule headings and the contents page are
 * usually real text, though, and reading them locally takes under a second
 * — enough to know which few pages are worth showing to the model at all.
 *
 * pdf.js runs here without a canvas and without its worker thread: the
 * worker module is imported in-process (which is also what makes the
 * host's bundler include it), and nothing is rendered, only the text read.
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loading: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    // Registers `globalThis.pdfjsWorker`, which pdf.js uses in place of a
    // worker thread when it finds one.
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  return loading;
}

/**
 * One string per page, in order — '' for a page with no text on it (a
 * drawing, a rendering, a scanned sheet). Null when the file cannot be
 * opened. Never throws.
 */
export async function pdfPageTexts(bytes: Buffer): Promise<string[] | null> {
  try {
    const { getDocument } = await pdfjs();
    // A copy: pdf.js takes ownership of the array it is given, and the
    // caller still needs these bytes to cut the pages it finds.
    const doc = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
    try {
      const texts: string[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        texts.push(
          content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        );
        page.cleanup();
      }
      return texts;
    } finally {
      await doc.destroy();
    }
  } catch (err) {
    console.warn('[pdfText] could not read the text layer:', (err as Error).message);
    return null;
  }
}
