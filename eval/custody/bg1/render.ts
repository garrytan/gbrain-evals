/**
 * BG1 render (GST-2010; docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md), run in custody by
 * eval/custody/bg1/mint.sh, one mint slot per call. It plans the slot's world from the custody seed and phrasing
 * (eval/generators/changing-facts-gen.ts), has gemini-3.8-flash write each session around its planned lines, checks
 * every session, and writes worlds/<id>/{plan,questions,world}.json under --set. It prints counts and hashes only.
 *
 *   bun eval/custody/bg1/render.ts --set <out>/set --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json --slot <n>
 *       [--cache <dir>, default <set>/../render-cache] [--target-tokens 200000]
 *       (--fake [--fake-break <slot>:<session index>:<attempts>,...]
 *        | --paid-window <unit> --window-cap-usd <n> --budget-ledger <file> --budget-run-id <id>)
 *   bun eval/custody/bg1/render.ts --dev <bg1-dev-01|bg1-dev-02|bg1-dev-03> --set <out>/set [--cache <dir>] [--target-tokens 200000]
 *       (--fake [--fake-break <dev number>:<session index>:<attempts>,...] | --paid-window ... as above)
 *   bun eval/custody/bg1/render.ts --dev-report <bg1-dev-NN> --set <out>/set [--budget-ledger <file> --budget-run-id <id>]
 *
 * Checks on every attempt at a session:
 *   1. deterministic (checkSession): the turns alternate, starting with the user; every planned line appears exactly
 *      once, verbatim, in a user turn, and a line planned for the middle sits in the middle half of the turns; no
 *      value, alias or implication from the world's lexicon appears outside its planned lines; every date token is one
 *      the session may use and none is damaged; no calendar date, year or weekday is written out; and, once a
 *      session's target is at least 400 tokens, its length is 0.6 to 1.5 times the target;
 *   2. gemini-3.8-flash reads the session for extra claims: a fact about a person, company, project or deal beyond
 *      the planned lines, or a turn that doubts, corrects or restates one;
 *   3. claude-haiku-5-5, the second validator from another family, asks the same of every session with a line on a
 *      tracked slot.
 * A failed attempt regenerates, up to 3 times. A session that fails all four attempts drops the world (exit 11) and
 * nothing of it is written under --set. The world-level gates (session count, values, the oracle cross-check) run in
 * the planner before any call.
 *
 * Model calls sit behind one interface (Models), so tests inject fakes. --fake writes each session with the template
 * renderer and answers both checks "no extra claims", spending nothing; --fake-break makes the stand-in reply with no
 * turns for one session's first attempts (a regeneration and drop drill). Real mode needs the granted paid
 * window, and refuses (exit 2) before any client exists without it or when a cap it would spend under is unknown or
 * above the window cap (eval/runner/paid-arm.ts). It reaches providers only through the metering proxies mint.sh
 * starts: BG1_GEMINI_READY and BG1_ANTHROPIC_READY name their ready files, each proxy holds only its own provider's
 * key and prices and reserves every request in the ledger, and a provider key in this process's own environment
 * refuses. Replies are cached under --cache by request hash, so a rerun after a crash buys nothing twice. A world
 * already written is skipped when its plan is unchanged; a changed plan refuses.
 *
 * --dev renders one of stage 1's three public dev worlds instead of a mint slot (mint.sh --dev runs all three). It
 * plans the world from its public seed and the public phrasing, as changing-facts-gen.ts devFiles() does, and reads no
 * seed or phrasing file, so it takes no --seed-file, --phrasing or --slot. Before any model call it refuses unless the
 * plan and its questions are byte-identical to the committed eval/data/changing-facts-v1/dev/worlds/<id>/plan.json and
 * questions.json. Rendering, the checks, regeneration, the cache, the models and the window guard are the ones above.
 * It writes worlds/<id>/{plan,questions,world}.json and a counts-only record, render/<id>.json, under --set, which
 * must sit outside any git checkout, as must the resolved --cache; nothing carries the custody marker. --dev-report prints a dev world's attempts
 * from that record and, given the ledger run, the requests and spend of its two metering proxies.
 *
 * Exit codes: 0 written or skipped, 11 dropped, 2 refused, 1 an error (printed as its class and a hash, never text).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  BG1_DATA_DIR, BG1_DEV_SEEDS, BG1_TARGET_TOKENS, BG1_WORLD_SCHEMA, buildQuestions, loadPhrasing, PlanError, planWorld, PUBLIC_PHRASING, renderBriefs, renderTemplateSession,
  sealedWorldSeed, termRegex, type Phrasing, type RenderBrief, type Turn, type World, type WorldPlan,
} from '../../generators/changing-facts-gen.ts';
import { readLedger } from '../../runner/budget-ledger.ts';
import { BG1_CONVERSATIONS, BG1_DEV_CONVERSATIONS } from '../../runner/bg1/types.ts';
import { ledgerCaps, requireRs1Window, WindowRefusal } from '../../runner/paid-arm.ts';
import { encodingCount } from '../../runner/systems/render-v2.ts';

export const RENDER_MODEL = 'gemini:gemini-3.8-flash';
export const CHECK_MODELS = ['gemini:gemini-3.8-flash', 'anthropic:claude-haiku-5-5'] as const;
export type CheckModel = typeof CHECK_MODELS[number];
export const REGENERATIONS = 3;
export const LENGTH_GATE = { min: 0.6, max: 1.5, from_target: 400 } as const;
export const CONCURRENCY = 6;
const CACHE_VERSION = 'bg1-render-cache/v1';
const SEED_LINE = /^bg1-seed-v1:[0-9a-f]{64}$/;
/** Provider keys this process must not hold in real mode: it reaches providers only through the proxies. */
const PROVIDER_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'BG1_GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

export class RenderRefusal extends Error {}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';

// ─── the deterministic check ─────────────────────────────────────────

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const RAW_DATES = [
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b`), new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`), /\b(?:19|20)\d{2}\b/, /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/, /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b/,
];
const DATE_TOKEN = /\[\[[DW]:-?\d+\]\]/g;

const occurrences = (hay: string, needle: string) => { let n = 0; for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++; return n; };

/**
 * The deterministic check of one rendered session against its brief: the names of the gates it fails (never text),
 * empty when it passes.
 */
export function checkSession(brief: RenderBrief, turns: unknown): string[] {
  if (!Array.isArray(turns) || turns.length < 2 || turns.some((t, i) => !t || (t as Turn).speaker !== (i % 2 ? 'assistant' : 'user') || typeof (t as Turn).content !== 'string' || !(t as Turn).content.trim())) return ['shape'];
  const ts = turns as Turn[];
  const fails = new Set<string>();
  const residue = ts.map(t => t.content);
  for (const line of brief.lines) {
    const hits = ts.map((t, i) => [i, occurrences(t.content, line.text)] as const).filter(([, n]) => n > 0);
    const total = hits.reduce((n, [, k]) => n + k, 0);
    if (total === 0) { fails.add('line_missing'); continue; }
    if (total > 1) { fails.add('line_repeated'); continue; }
    const at = hits[0][0];
    if (ts[at].speaker !== line.speaker) fails.add('line_speaker');
    const quarter = Math.floor(ts.length / 4);
    if (line.position === 'middle' && (at < quarter || at >= ts.length - quarter)) fails.add('line_position');
    residue[at] = residue[at].replace(line.text, ' ');
  }
  for (const text of residue) {
    if (brief.forbidden.some(term => termRegex(term).test(text))) fails.add('value_outside');
    for (const token of text.match(DATE_TOKEN) ?? []) if (!brief.allowed_tokens.includes(token)) fails.add('date_token');
    const bare = text.replace(DATE_TOKEN, ' ');
    if (bare.includes('[[') || bare.includes(']]')) fails.add('date_token');
    if (RAW_DATES.some(re => re.test(bare))) fails.add('raw_date');
  }
  if (brief.target_tokens >= LENGTH_GATE.from_target) {
    const tokens = ts.reduce((n, t) => n + encodingCount('cl100k_base', t.content), 0);
    if (tokens < LENGTH_GATE.min * brief.target_tokens || tokens > LENGTH_GATE.max * brief.target_tokens) fails.add('length');
  }
  return [...fails].sort();
}

// ─── prompts ─────────────────────────────────────────────────────────

const FAILURE_HINTS: Readonly<Record<string, string>> = {
  shape: 'The reply must be the JSON object described, with turns alternating user, assistant, user and so on, starting with the user.',
  line_missing: 'Every required line must appear word for word.', line_repeated: 'Each required line must appear exactly once.',
  line_speaker: 'Only the user says the required lines.', line_position: 'Lines marked (middle) go in the middle half of the turns.',
  value_outside: 'No forbidden word may appear outside the required lines, not even in the assistant\'s replies.',
  date_token: 'Copy date tokens exactly and use no others.', raw_date: 'Write no calendar dates, years, month dates or weekday names.',
  length: 'Keep to the requested length.', extra_claims: 'State no facts about the named people, companies, projects or deals beyond the required lines, and never restate, doubt or correct those lines.',
};

/** The prompt that asks gemini-3.8-flash for one session. A regeneration names the gates the last attempt failed. */
export function renderPrompt(brief: RenderBrief, attempt: number, failures: readonly string[]): string {
  return [
    'You write one chat session between a user and an AI assistant for a synthetic long-term memory benchmark. Everything in it is fictional.',
    '',
    `The session is mostly about: ${brief.topic}. It takes place on [[W:${brief.day}]] at ${brief.time}.`,
    `Write about ${brief.target_tokens} tokens in total, as alternating turns starting with the user. The user speaks casually; the assistant is helpful and brief.`,
    ...(brief.lines.length ? [
      '',
      'At natural points the user must say each of these lines word for word, each inside one of the user\'s turns (other sentences may surround it). Lines marked (middle) belong in the middle half of the session:',
      ...brief.lines.map((l, i) => `${i + 1}. ${l.position === 'middle' ? '(middle) ' : ''}${l.text}`),
      '',
      'When the user says one of these lines, the assistant acknowledges it in a few words without repeating any name, place, number or other detail from it.',
    ] : []),
    '',
    'Rules:',
    `- These words must not appear anywhere except inside the lines above: ${brief.forbidden.join('; ')}.`,
    `- Say nothing about these people, companies, projects or deals beyond the lines above: ${brief.entities.join('; ')}. Do not mention them at all unless a line does.`,
    '- Do not write calendar dates, years, month names with a day, or weekday names. Tokens such as [[D:-12]] appear only inside the lines above; copy them exactly and add no others.',
    '- Never restate, question or correct a line above.',
    ...(attempt > 0 && failures.length ? ['', `This is attempt ${attempt + 1}. The last attempt broke these rules: ${failures.map(f => FAILURE_HINTS[f.split(':')[0]] ?? f).join(' ')}`] : []),
    '',
    'Reply with only a JSON object: {"turns": [{"speaker": "user", "content": "..."}, {"speaker": "assistant", "content": "..."}]}',
  ].join('\n');
}

/** The prompt both checking models answer for one session. */
export function checkPrompt(brief: RenderBrief, turns: readonly Turn[]): string {
  return [
    'You check one chat session from a synthetic memory benchmark. The session was written around some required lines, which are the only places it may state facts about the people, companies, projects and deals it names.',
    '',
    '<required_lines>', ...(brief.lines.length ? brief.lines.map((l, i) => `${i + 1}. ${l.text}`) : ['(none)']), '</required_lines>',
    '<names>', brief.entities.join('; '), '</names>',
    '<session>', ...turns.map(t => `${t.speaker}: ${t.content}`), '</session>',
    '',
    'Outside the required lines, does the session state or imply any fact about a named person, company, project or deal (where someone lives or works, a job title, who runs or leads something, a vendor or customer, a price, seat count, discount or contract term, a merger, an offsite, a pilot), or restate, doubt or correct a required line?',
    '',
    'Reply with only a JSON object: {"extra_claims": true} or {"extra_claims": false}.',
  ].join('\n');
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const v = JSON.parse(text.slice(start, end + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
export const parseTurns = (reply: string): unknown => jsonObject(reply)?.turns ?? null;
export const parseVerdict = (reply: string): boolean | null => { const v = jsonObject(reply)?.extra_claims; return typeof v === 'boolean' ? v : null; };

// ─── models ──────────────────────────────────────────────────────────

export interface Models {
  renderer: string;
  render(brief: RenderBrief, attempt: number, failures: readonly string[]): Promise<string>;
  check(model: CheckModel, brief: RenderBrief, turns: readonly Turn[]): Promise<string>;
}

export interface ModelClient { id: string; complete(prompt: string, maxOutputTokens: number, temperature: number): Promise<string> }

/** Replies cached by request hash under dir, so a rerun buys nothing it already bought. */
export function cachedClient(client: ModelClient, dir: string): ModelClient {
  mkdirSync(dir, { recursive: true });
  return {
    id: client.id,
    async complete(prompt, maxOutputTokens, temperature) {
      const path = join(dir, `${sha256([CACHE_VERSION, client.id, String(maxOutputTokens), String(temperature), prompt].join('\u0000'))}.txt`);
      if (existsSync(path)) return readFileSync(path, 'utf8');
      const reply = await client.complete(prompt, maxOutputTokens, temperature);
      writeFileSync(`${path}.tmp`, reply, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      return reply;
    },
  };
}

export function clientModels(gemini: ModelClient, haiku: ModelClient): Models {
  return {
    renderer: gemini.id,
    render: (brief, attempt, failures) => gemini.complete(renderPrompt(brief, attempt, failures), Math.min(65_536, Math.ceil(brief.target_tokens * 1.6) + 2048), 1),
    check: (model, brief, turns) => (model === CHECK_MODELS[0] ? gemini : haiku).complete(checkPrompt(brief, turns), 256, 0),
  };
}

/** --fake: the template renderer writes each session (an empty reply for the broken attempts) and both checks pass. */
export function fakeModels(plan: WorldPlan, breaks: ReadonlyMap<number, number> = new Map()): Models {
  return {
    renderer: 'fake-template',
    async render(brief, attempt) {
      const i = plan.sessions.findIndex(s => s.id === brief.session);
      if (attempt < (breaks.get(i) ?? 0)) return '{"turns": []}';
      return JSON.stringify({ turns: renderTemplateSession(plan, plan.sessions[i], brief.target_tokens) });
    },
    async check() { return '{"extra_claims": false}'; },
  };
}

/** A metering proxy's base URL and token for one provider, from the ready file mint.sh wrote; refuses anything but a loopback proxy token. */
export function proxyEndpoint(readyPath: string | undefined, provider: 'gemini' | 'anthropic'): { base: string; token: string } {
  const name = provider === 'gemini' ? 'BG1_GEMINI_READY' : 'BG1_ANTHROPIC_READY';
  if (!readyPath) throw new RenderRefusal(`real mode needs ${name} (mint.sh starts one metering proxy per provider)`);
  let env: Record<string, string> = {};
  try { env = (JSON.parse(readFileSync(readyPath, 'utf8')) as { env?: Record<string, Record<string, string>> }).env?.bg1 ?? {}; } catch { throw new RenderRefusal(`${name} names no readable ready file`); }
  const [baseVar, keyVar] = provider === 'gemini' ? ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY'] : ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'];
  const base = env[baseVar], token = env[keyVar];
  if (!base || !token) throw new RenderRefusal(`the metering proxy in ${name} does not serve ${provider}`);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(base)) throw new RenderRefusal(`the ${provider} base URL is not the loopback metering proxy`);
  if (!token.startsWith('mpwp-bg1-')) throw new RenderRefusal(`the ${provider} credential is not a bg1 metering-proxy token`);
  return { base, token };
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
/** POST with up to three retries on a transient status. An error names only the status: a body could echo the prompt. */
async function post(url: string, headers: Record<string, string>, body: unknown, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    await res.body?.cancel();
    if (res.status === 402) throw new RenderRefusal('the metering proxy refused a request: the budget run or the program cap has no room (the run pauses for an extension)');
    if (!RETRY_STATUS.has(res.status) || attempt >= 3) throw new Error(`the metering proxy answered HTTP ${res.status}`);
    await sleep(2000 * 2 ** attempt);
  }
}

export function geminiProxyClient(readyPath: string | undefined): ModelClient {
  const { base, token } = proxyEndpoint(readyPath, 'gemini');
  return {
    id: CHECK_MODELS[0],
    async complete(prompt, maxOutputTokens, temperature) {
      const reply = await post(`${base.replace(/\/$/, '')}/v1beta/models/gemini-3.8-flash:generateContent`, { 'x-goog-api-key': token },
        { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens, temperature, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } });
      return (reply.candidates?.[0]?.content?.parts ?? []).map((x: { text?: string }) => x.text ?? '').join('');
    },
  };
}

/** claude-haiku-5-5 rejects temperature, so it samples at the provider default. */
export function haikuProxyClient(readyPath: string | undefined): ModelClient {
  const { base, token } = proxyEndpoint(readyPath, 'anthropic');
  return {
    id: CHECK_MODELS[1],
    async complete(prompt, maxTokens) {
      const reply = await post(`${base.replace(/\/$/, '')}/v1/messages`, { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
        { model: 'claude-haiku-5-5', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
      return (reply.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    },
  };
}

// ─── rendering a world ───────────────────────────────────────────────

export interface RenderStats { sessions: number; attempts: number; regenerated: number; checks: number; failures: Record<string, number>; dropped_session: number | null; tokens: number }

/**
 * Every session of a plan through the renderer and the three checks, up to 1 + REGENERATIONS attempts each. Returns
 * the world, or null with dropped_session set once a session fails every attempt (sessions not yet started are skipped).
 */
export async function renderWorld(plan: WorldPlan, models: Models, opts: { targetTokens?: number; concurrency?: number } = {}): Promise<{ world: World | null; stats: RenderStats }> {
  const briefs = renderBriefs(plan, opts.targetTokens ?? BG1_TARGET_TOKENS);
  const stats: RenderStats = { sessions: briefs.length, attempts: 0, regenerated: 0, checks: 0, failures: {}, dropped_session: null, tokens: 0 };
  const done: Array<Turn[] | null> = briefs.map(() => null);
  const one = async (i: number) => {
    const brief = briefs[i];
    let failures: string[] = [];
    for (let attempt = 0; attempt <= REGENERATIONS; attempt++) {
      stats.attempts++;
      if (attempt > 0) stats.regenerated++;
      const turns = parseTurns(await models.render(brief, attempt, failures));
      failures = checkSession(brief, turns);
      for (const model of failures.length ? [] : CHECK_MODELS.filter(m => m === CHECK_MODELS[0] || brief.tracked)) {
        stats.checks++;
        const verdict = parseVerdict(await models.check(model, brief, turns as Turn[]));
        if (verdict !== false) { failures = [verdict === null ? `check_unreadable:${model}` : `extra_claims:${model}`]; break; }
      }
      for (const f of failures) stats.failures[f] = (stats.failures[f] ?? 0) + 1;
      if (!failures.length) { done[i] = turns as Turn[]; return; }
    }
    if (stats.dropped_session === null || i < stats.dropped_session) stats.dropped_session = i;
  };
  let next = 0;
  const worker = async () => { while (stats.dropped_session === null && next < briefs.length) await one(next++); };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? CONCURRENCY) }, worker));
  if (stats.dropped_session !== null) return { world: null, stats };
  const sessions = plan.sessions.map((s, i) => ({ id: s.id, day: s.day, time: s.time, turns: done[i]! }));
  stats.tokens = sessions.reduce((n, s) => n + s.turns.reduce((m, t) => m + encodingCount('cl100k_base', t.content), 0), 0);
  return { world: { schema: BG1_WORLD_SCHEMA, id: plan.id, ...(plan.custody ? { custody: plan.custody } : {}), world_end_weekday: plan.world_end_weekday, renderer: models.renderer, sessions }, stats };
}

// ─── custody inputs ──────────────────────────────────────────────────

const ownerOnly = (path: string) => (statSync(path).mode & 0o077) === 0;

/** The custody seed line: a *.bg1-seed file, owner-only, holding "bg1-seed-v1:" and 64 hex digits. */
export function readSeedLine(path: string): string {
  if (!path.endsWith('.bg1-seed')) throw new RenderRefusal('the seed file must be named *.bg1-seed');
  if (!existsSync(path)) throw new RenderRefusal('the seed file does not exist');
  if (!ownerOnly(path)) throw new RenderRefusal('the seed file must be mode 600 or 400');
  const line = readFileSync(path, 'utf8').trim();
  if (!SEED_LINE.test(line)) throw new RenderRefusal('the seed file does not hold one bg1-seed-v1 line');
  return line;
}

/** The custody phrasing set: a *.bg1-phrasing.json file, owner-only, with the custody marker (loadPhrasing checks the rest). */
export function readPhrasing(path: string): Phrasing {
  if (!path.endsWith('.bg1-phrasing.json')) throw new RenderRefusal('the phrasing file must be named *.bg1-phrasing.json');
  if (!existsSync(path)) throw new RenderRefusal('the phrasing file does not exist');
  if (!ownerOnly(path)) throw new RenderRefusal('the phrasing file must be mode 600 or 400');
  try { return loadPhrasing(path); } catch (e) { throw new RenderRefusal(e instanceof PlanError ? e.message : 'the phrasing file is not readable JSON'); }
}

export const worldIdOf = (slot: number) => {
  const id = BG1_CONVERSATIONS[slot - 1];
  if (!Number.isInteger(slot) || !id) throw new RenderRefusal(`--slot must be a whole number from 1 to ${BG1_CONVERSATIONS.length}`);
  return id;
};

/** The sealed plan of one mint slot: deterministic from the custody seed line, the slot and the phrasing set. */
export const sealedPlan = (seedLine: string, slot: number, phrasing: Phrasing) => planWorld(worldIdOf(slot), sealedWorldSeed(seedLine, slot), { phrasing, custody: true });

/** The committed public dev worlds' plans and questions, as changing-facts-gen.ts devFiles() writes them. */
export const BG1_DEV_WORLDS = join(BG1_DATA_DIR, 'dev', 'worlds');

/**
 * A public dev world's plan, planned as devFiles() plans it. Refuses unless the plan and its questions are
 * byte-identical to plan.json and questions.json under worlds/<id>, so the rendered world is the committed gold's.
 */
export function devPlan(id: string, worlds = BG1_DEV_WORLDS): WorldPlan {
  const plan = planWorld(id, BG1_DEV_SEEDS[id], { publicSeed: true });
  for (const [name, text] of [['plan.json', json(plan)], ['questions.json', json(buildQuestions(plan, PUBLIC_PHRASING))]]) {
    const path = join(worlds, id, name);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) throw new RenderRefusal(`${id}'s ${name} differs from the committed eval/data/changing-facts-v1/dev/worlds/${id}/${name}`);
  }
  return plan;
}

/** True when path, or its nearest existing parent, sits inside a git work tree; refuses when git cannot say. */
function insideCheckout(path: string): boolean {
  let dir = resolve(path);
  while (!existsSync(dir)) dir = dirname(dir);
  const git = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  if (git.error) throw new RenderRefusal('git is not on PATH, so --set cannot be checked for a checkout');
  return git.status === 0;
}

/**
 * One dev world's counts after mint.sh --dev: its record's status and attempts and, given the ledger run, the requests
 * its two metering proxies (cells bg1-<id>-gemini and bg1-<id>-anthropic) reserved and their spend, each request at
 * its settled cost from the provider's usage or its reservation where none was reported (counted as unreconciled).
 */
export function devReport(argv: string[]): string {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const id = flag('--dev-report') ?? '', set = flag('--set'), ledger = flag('--budget-ledger'), run = flag('--budget-run-id');
  if (!BG1_DEV_CONVERSATIONS.includes(id) || !set || !ledger !== !run) throw new RenderRefusal('usage: --dev-report <bg1-dev-NN> --set <dir> [--budget-ledger <file> --budget-run-id <id>]');
  const record = join(resolve(set), 'render', `${id}.json`);
  const stats = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) as { status: string; attempts: number; regenerated: number } : null;
  const parts = [`bg1-render world=${id} report`, stats ? `status=${stats.status} attempts=${stats.attempts} regenerated=${stats.regenerated}` : 'record=missing'];
  if (ledger && run) {
    const cells = [`(proxy bg1-${id}-gemini/`, `(proxy bg1-${id}-anthropic/`];
    const entries = readLedger(resolve(ledger)).entries.filter(e => e.run_id === run && cells.some(c => e.description.includes(c)));
    parts.push(`requests=${entries.length} spend_usd=${entries.reduce((n, e) => n + (e.actual_usd ?? e.reserved_usd), 0).toFixed(4)} unreconciled=${entries.filter(e => e.status !== 'reconciled').length}`);
  }
  return parts.join(' ');
}

function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

// ─── command line ────────────────────────────────────────────────────

export interface RenderOutcome { status: 'written' | 'skipped' | 'dropped'; line: string }

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, models?: (plan: WorldPlan) => Models, devWorlds = BG1_DEV_WORLDS): Promise<RenderOutcome> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const set = flag('--set'), seedFile = flag('--seed-file'), phrasingFile = flag('--phrasing'), slotText = flag('--slot');
  const dev = argv.includes('--dev') ? flag('--dev') ?? '' : null;
  if (dev !== null) {
    if (seedFile || phrasingFile || slotText) throw new RenderRefusal('--dev plans a public dev world from its public seed and phrasing, so it takes no --seed-file, --phrasing or --slot');
    if (!set || !BG1_DEV_CONVERSATIONS.includes(dev)) throw new RenderRefusal(`usage: --dev <${BG1_DEV_CONVERSATIONS.join('|')}> --set <dir> (--fake | --paid-window <unit> --window-cap-usd <n> --budget-ledger <file> --budget-run-id <id>)`);
    if (insideCheckout(set)) throw new RenderRefusal('--set must sit outside any git checkout');
  } else if (!set || !seedFile || !phrasingFile || !slotText) throw new RenderRefusal('usage: --set <dir> --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json --slot <n> (--fake | --paid-window <unit> --window-cap-usd <n> --budget-ledger <file> --budget-run-id <id>)');
  const cache = resolve(flag('--cache') ?? join(dirname(resolve(set)), 'render-cache'));
  if (dev !== null && insideCheckout(cache)) throw new RenderRefusal('--cache must sit outside any git checkout');
  const fake = argv.includes('--fake');
  const targetTokens = Number(flag('--target-tokens') ?? BG1_TARGET_TOKENS);
  if (!(Number.isInteger(targetTokens) && targetTokens >= 1000)) throw new RenderRefusal('--target-tokens must be a whole number of at least 1000');
  let make = models;
  if (!make && !fake) {
    const ledger = flag('--budget-ledger'), run = flag('--budget-run-id');
    requireRs1Window(argv, { what: 'bg1 render', keyless: false, caps: () => (ledger && run ? ledgerCaps(ledger, run) : [{ label: 'the budget ledger run (--budget-ledger and --budget-run-id)', usd: null }]) });
    const held = PROVIDER_KEYS.filter(k => env[k]);
    if (held.length) throw new RenderRefusal(`real mode reaches providers only through the metering proxies, and this process holds ${held.join(', ')}`);
    const gemini = cachedClient(geminiProxyClient(env.BG1_GEMINI_READY), cache), haiku = cachedClient(haikuProxyClient(env.BG1_ANTHROPIC_READY), cache);
    make = () => clientModels(gemini, haiku);
  }
  const slot = dev === null ? Number(slotText) : BG1_DEV_CONVERSATIONS.indexOf(dev) + 1;
  const id = dev ?? worldIdOf(slot);
  const phrasing = dev === null ? readPhrasing(resolve(phrasingFile!)) : PUBLIC_PHRASING;
  const plan = dev === null ? sealedPlan(readSeedLine(resolve(seedFile!)), slot, phrasing) : devPlan(dev, devWorlds);
  const label = dev === null ? `slot=${slot} world=${id}` : `world=${id}`;
  if (!make) {
    const breaks = new Map<number, number>();
    for (const entry of (flag('--fake-break') ?? '').split(',').filter(Boolean)) {
      const [s, i, n] = entry.split(':').map(Number);
      if (s === slot) breaks.set(i, n);
    }
    make = p => fakeModels(p, breaks);
  }
  const dir = join(resolve(set), 'worlds', id);
  const planText = json(plan);
  if (existsSync(join(dir, 'world.json'))) {
    if (!existsSync(join(dir, 'plan.json')) || readFileSync(join(dir, 'plan.json'), 'utf8') !== planText) throw new RenderRefusal(`${id} is already written from a different plan`);
    return { status: 'skipped', line: `bg1-render ${label} status=skipped world_sha256=${sha256(readFileSync(join(dir, 'world.json'))).slice(0, 16)}` };
  }
  const { world, stats } = await renderWorld(plan, make(plan), { targetTokens });
  const failures = Object.entries(stats.failures).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join(',') || 'none';
  const counts = `sessions=${stats.sessions} attempts=${stats.attempts} regenerated=${stats.regenerated} checks=${stats.checks} failures=${failures}`;
  const record = join(dev === null ? dirname(resolve(set)) : resolve(set), 'render', `${id}.json`);
  if (!world) {
    writeAtomic(record, json({ world: id, status: 'dropped', ...stats }));
    return { status: 'dropped', line: `bg1-render ${label} status=dropped dropped_session=${stats.dropped_session} ${counts}` };
  }
  const worldText = json(world);
  writeAtomic(join(dir, 'plan.json'), planText);
  writeAtomic(join(dir, 'questions.json'), json(buildQuestions(plan, phrasing)));
  writeAtomic(join(dir, 'world.json'), worldText);
  writeAtomic(record, json({ world: id, status: 'written', world_sha256: sha256(worldText), ...stats }));
  return { status: 'written', line: `bg1-render ${label} status=written ${counts} tokens=${stats.tokens} world_sha256=${sha256(worldText).slice(0, 16)}` };
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--dev-report')) { console.log(devReport(argv)); process.exit(0); }
    const out = await main(argv);
    console.log(out.line);
    process.exit(out.status === 'dropped' ? 11 : 0);
  } catch (error) {
    const e = error as Error;
    const refused = e instanceof RenderRefusal || e instanceof WindowRefusal;
    process.stderr.write(refused ? `bg1-render refused: ${e.message}\n` : `bg1-render error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(refused ? 2 : 1);
  }
}

