/**
 * Since gbrain v0.60.536.0 a remote read returns text below the owner's tier (written by an agent, tool data, external,
 * or unverified origin) inside a quote fence marked as source material, with `quoted: 'transcript'` on the row
 * (src/core/search/transcript-quote.ts). The fence is a delivery wrapper: the stored text is inside it, and the row's
 * trust_tier still says who wrote it. A harness that compares returned text with what it wrote reads the text inside
 * the fence through the build's own inverse, and fails loudly on a build that quotes without one.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importGbrain, type GbrainUnderTest } from './gbrain-under-test.ts';

export type Unquote = (text: string) => string;

/** The build's `unquoteFactText` (v0.60.538.0 on), or undefined on a build without it. */
export async function loadFactUnquote(gut: GbrainUnderTest): Promise<Unquote | undefined> {
  const module = 'src/core/search/transcript-quote.ts';
  if (!existsSync(join(gut.root, module))) return undefined;
  return (await importGbrain<{ unquoteFactText?: Unquote }>(gut, module)).unquoteFactText;
}

/** A returned fact's stored text: unquoted when the row says it was quoted. */
export function storedFactText(text: string, quoted: unknown, unquote: Unquote | undefined): string {
  if (!quoted) return text;
  if (!unquote) throw new Error('gbrain returned a quote-fenced fact, and this build exports no unquoteFactText (v0.60.536.0 and v0.60.537.0 fence facts without it); measure another build');
  return unquote(text);
}
