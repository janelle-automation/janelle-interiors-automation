// pdf.js ships no types for its worker module. It is imported only for its
// side effect — registering `globalThis.pdfjsWorker` — so nothing is read from it.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
