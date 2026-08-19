/**
 * Thin pdf-parse wrapper for BrainBench v1 Cat 11 multimodal ingest.
 *
 * pdf-parse is loaded lazily (dynamic import) so module load does not
 * trigger any debug-mode file reads that the library does on some versions.
 * Lazy import also keeps the dep out of the production bundle path — only
 * eval/runner/cat11-multimodal.ts imports this file.
 *
 * Guards:
 *   - Size cap (default 50MB) — prevents ingesting malicious/malformed pathological PDFs
 *   - Encrypted PDFs throw `PdfEncryptedError` with a clear message instead of
 *     hanging or returning garbage
 *   - Empty/corrupt PDFs throw `PdfParseError` with path + errno-style context
 *
 * No production code path consumes this loader. Cat 11 test fixtures only.
 */

import { statSync } from 'fs';
import { readFile } from 'fs/promises';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB

export class PdfEncryptedError extends Error {
  readonly kind = 'encrypted' as const;
  constructor(path: string) {
    super(`PDF is encrypted: ${path}`);
    this.name = 'PdfEncryptedError';
  }
}

export class PdfParseError extends Error {
  readonly kind = 'parse' as const;
  constructor(path: string, cause?: unknown) {
    super(`PDF parse failed: ${path}${cause ? ` (${String(cause)})` : ''}`);
    this.name = 'PdfParseError';
    if (cause instanceof Error) this.cause = cause;
  }
}

export class PdfTooLargeError extends Error {
  readonly kind = 'too_large' as const;
  constructor(path: string, sizeBytes: number, maxBytes: number) {
    super(`PDF too large: ${path} is ${sizeBytes} bytes, max ${maxBytes}`);
    this.name = 'PdfTooLargeError';
  }
}

export interface PdfExtractOptions {
  /** Max PDF size in bytes. Default 50MB. */
  maxBytes?: number;
}

export interface PdfExtractResult {
  /** Full extracted text, newline-joined across pages. */
  text: string;
  /** Number of pages in the PDF. */
  numPages: number;
  /** Raw PDF metadata dictionary (title, author, etc.) if present. */
  info?: Record<string, unknown>;
}

/**
 * Extract text from a PDF file path. Size-guarded and encryption-aware.
 *
 * This is the ONLY entry point for PDF extraction in BrainBench. The
 * pdf-parse package is lazy-loaded here so that (a) a module-load crash in
 * pdf-parse cannot break unrelated eval runners and (b) the dep stays in
 * devDependencies — production gbrain binary never sees it.
 */
export async function extractPdfText(
  path: string,
  opts: PdfExtractOptions = {},
): Promise<PdfExtractResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Size guard BEFORE reading into memory.
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    throw new PdfParseError(path, err);
  }
  if (stat.size > maxBytes) {
    throw new PdfTooLargeError(path, stat.size, maxBytes);
  }

  const buffer = await readFile(path);

  // Lazy import — avoids triggering any init-time side-effects of pdf-parse
  // unless this function is actually called. pdf-parse v2 exports a PDFParse
  // class (vs v1's bare function); v1 also exposed a default export. Try both
  // shapes so the loader survives a future v1↔v2 swap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfParseModule: any = await import('pdf-parse');
  const PDFParse = pdfParseModule.PDFParse ?? pdfParseModule.default?.PDFParse;
  const legacyParse = typeof pdfParseModule.default === 'function'
    ? pdfParseModule.default
    : (typeof pdfParseModule === 'function' ? pdfParseModule : null);

  try {
    if (PDFParse) {
      // v2 API: instantiate, call getText().
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return {
        text: String(result.text ?? ''),
        numPages: Number(result.total ?? result.numpages ?? 0),
        info: result.info ? { ...result.info } : undefined,
      };
    }
    if (legacyParse) {
      // v1 API: call directly.
      const result = await legacyParse(buffer);
      return {
        text: String(result.text ?? ''),
        numPages: Number(result.numpages ?? 0),
        info: result.info ? { ...result.info } : undefined,
      };
    }
    throw new PdfParseError(path, new Error('pdf-parse exposes neither PDFParse class nor a default function'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(message) || /password/i.test(message)) {
      throw new PdfEncryptedError(path);
    }
    if (err instanceof PdfParseError) throw err;
    throw new PdfParseError(path, err);
  }
}
