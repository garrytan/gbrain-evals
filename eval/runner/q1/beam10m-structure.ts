/**
 * BEAM structure check (Q1 PLAN §4.8.6): counts only, never text, never
 * questions. It reports whether turn groups exist, how many carry a
 * `time_anchor`, which date fallback the corpus loader applies, and the
 * session size distribution, including sessions over 24,000 tokens (the
 * size above which gbrain's conversation auto-delivery falls back to chunks).
 *
 *   bun eval/runner/q1/beam10m-structure.ts --chat-file <chat.json> [--conversation <id>] [--json]
 *       any BEAM chat file, for example a public BEAM-1M dev conversation;
 *   bun eval/runner/q1/beam10m-structure.ts [--conversation 10m-<n>]... [--json]
 *       BEAM-10M corpus files from the manifest, custodian only
 *       (GBRAIN_EVALS_CUSTODY_LOG; each opening is logged).
 *
 * Session size is the page body a system receives (`**<speaker>:** <text>`
 * per turn), in characters and local `cl100k_base` tokens. Its only repository
 * import is the corpus-only loader, so it cannot read a question file.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DecideError, decideError, exitCodeFor, renderOperatorMessage } from '../decisions/errors.ts';
import { beamChatSessions, loadBeam10mCorpus, type BeamStructure } from '../memory-qa/beam10m-corpus.ts';
import type { Session } from '../memory-qa/corpus.ts';

export const OVER_TOKENS = 24_000;
const requireLocal = createRequire(import.meta.url);
let cl100k: { encode(t: string, a?: string[], d?: string[]): Uint32Array } | null = null;
const tokens = (text: string) => (cl100k ??= (requireLocal('@dqbd/tiktoken') as { get_encoding(e: string): NonNullable<typeof cl100k> }).get_encoding('cl100k_base')).encode(text, [], []).length;

export const sessionBody = (s: Session) => s.turns.map(t => `**${t.speaker}:** ${t.content}\n`).join('\n');

const dist = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : 0;
  return { min: s[0] ?? 0, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? 0 };
};

export interface StructureReport extends BeamStructure {
  session_chars: { min: number; p50: number; p95: number; max: number };
  session_tokens_cl100k: { min: number; p50: number; p95: number; max: number };
  sessions_over_24000_tokens: number;
  total_tokens_cl100k: number;
}

export function structureReport(structure: BeamStructure, sessions: readonly Session[]): StructureReport {
  const bodies = sessions.map(sessionBody);
  const toks = bodies.map(tokens);
  return { ...structure, session_chars: dist(bodies.map(b => b.length)), session_tokens_cl100k: dist(toks), sessions_over_24000_tokens: toks.filter(t => t > OVER_TOKENS).length, total_tokens_cl100k: toks.reduce((a, b) => a + b, 0) };
}

export function main(argv: string[]): number {
  const json = argv.includes('--json');
  const many = (n: string) => argv.flatMap((a, i) => a === n ? [argv[i + 1]] : []);
  try {
    const chatFile = many('--chat-file')[0];
    let reports: StructureReport[];
    if (chatFile) {
      const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as unknown;
      const chat = Array.isArray(raw) ? raw : (raw as { chat?: unknown }).chat;
      const s = beamChatSessions(many('--conversation')[0] ?? 'chat-file', chat);
      reports = [structureReport(s.structure, s.sessions)];
    } else {
      const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
      if (!log) throw decideError({ code: 'CUSTODY_MISSING', message: 'the BEAM-10M structure check reads sealed corpus files', why: 'BEAM-10M files exist only on the custody host and every opening is logged',
        fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/q1/beam10m-structure.ts', '--json'], user_message: 'the custodian runs the structure check with GBRAIN_EVALS_CUSTODY_LOG set and shares the counts' } });
      const only = many('--conversation');
      const corpus = loadBeam10mCorpus({ log, ...(only.length ? { only: new Set(only) } : {}) });
      reports = corpus.structure.map((s, i) => structureReport(s, corpus.conversations[i].sessions));
    }
    if (json) process.stdout.write(JSON.stringify(reports, null, 1) + '\n');
    else for (const r of reports) process.stdout.write([
      `${r.conversation}: ${r.shape}, ${r.plans} plans, ${r.batches} batches, ${r.turn_groups} turn groups (${r.groups_with_time_anchor} with a time_anchor; ${r.batches_with_time_anchor} batches anchored)`,
      `  ${r.sessions} sessions (${r.synthesized_sessions} synthesized at message pairs), dates: ${r.date_source} (own ${r.sessions_with_own_anchor}, batch ${r.sessions_with_batch_anchor}, none ${r.sessions_without_anchor}, unparseable ${r.unparseable_anchors}, monotone ${r.anchors_monotone})`,
      `  ${r.messages} messages, ${r.messages_without_id} without id, ${r.duplicate_message_ids} duplicated ids`,
      `  session tokens (cl100k) min ${r.session_tokens_cl100k.min} p50 ${r.session_tokens_cl100k.p50} p95 ${r.session_tokens_cl100k.p95} max ${r.session_tokens_cl100k.max}; over ${OVER_TOKENS}: ${r.sessions_over_24000_tokens}; total ${r.total_tokens_cl100k}`,
    ].join('\n') + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof DecideError)) throw e;
    process.stderr.write((json ? JSON.stringify(e.op) : renderOperatorMessage(e.op)) + '\n');
    return exitCodeFor(e.op);
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
