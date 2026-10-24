// Downloaded bid documents still being read automatically (lib/psDocs.mjs documents_read): scanned files the
// OCR layers (scripts/ocr-job.mjs on GitHub, lib/ocrVision.mjs) haven't read yet. They are read without anyone
// doing anything; their products and dates appear in View details when done. PhilGEPS and PS-PhilGEPS alike.

/** The scanned files of a documents_read list waiting for OCR, e.g. [{ name, kind }] */
export const readingDocuments = (read) => (read || []).filter((doc) => doc.kind === 'scanned' && !doc.ocr);

export const stillReading = (read) => readingDocuments(read).length > 0;
