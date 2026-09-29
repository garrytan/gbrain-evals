/**
 * Opaque LongMemEval session ids (audit C-01, PD-05, PD-08).
 *
 * Every gold session id in LongMemEval starts with `answer_` and no other
 * haystack session does, so a raw id in a slug, title, frontmatter or reader
 * prompt tells the system under test which sessions hold the answer. Runners
 * give the system under test and any reader only `s-` plus the first 10 hex
 * characters of sha256(salt + ':' + session_id), and keep the map back to the
 * original id for scoring, so recall stays comparable with earlier rows.
 *
 * The salt is the question id where the runner knows it, or the frozen source
 * hash for the source-only M-pilot build, which never sees the question.
 */
import { createHash } from 'node:crypto';

export const SESSION_ID_POLICY = 'opaque-sha256-10-v1';

export function opaqueSessionId(salt: string, sessionId: string): string {
  return 's-' + createHash('sha256').update(`${salt}:${sessionId}`).digest('hex').slice(0, 10);
}

/** Opaque id → original id (lowercased, as gbrain slugs and scoring use it). Throws on a collision between different originals. */
export function opaqueSessionMap(salt: string, sessionIds: readonly string[]): Map<string, string> {
  const originalByOpaque = new Map<string, string>();
  for (const sessionId of sessionIds) {
    const opaque = opaqueSessionId(salt, sessionId);
    const prior = originalByOpaque.get(opaque);
    if (prior !== undefined && prior !== sessionId.toLowerCase()) throw new Error(`opaque session id collision for ${salt}`);
    originalByOpaque.set(opaque, sessionId.toLowerCase());
  }
  return originalByOpaque;
}
