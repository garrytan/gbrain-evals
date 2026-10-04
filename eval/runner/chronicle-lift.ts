/**
 * auto_chronicle OFF versus ON lift experiment (preregistered in
 * docs/benchmarks/2026-10-04-auto-chronicle-lift-preregistration.md).
 *
 * gbrain v0.60.45.0 turned on automatic event extraction: meeting,
 * conversation and calendar pages are read once by the chat model and their
 * events are written as timeline event pages. This runner builds the same
 * fixed world (eval/data/amara-life-v1, not regenerated) into PGLite brains
 * that differ only in `auto_chronicle`, runs the `chronicle` cycle phase,
 * scores the extracted events against hand labels
 * (eval/data/chronicle-lift-v1/gold-events.json) and asks an agent the same
 * temporal questions (eval/data/chronicle-lift-v1/questions.json) against
 * each brain over gbrain's MCP server.
 *
 *   bun eval/runner/chronicle-lift.ts corpus --out <dir>                    # render the vault only, $0
 *   bun eval/runner/chronicle-lift.ts run --out <dir> --budget-usd <n> [--arms off,on-a,on-b] [--repeats 2]
 *        [--model claude-sonnet-4-6] [--questions <ids>] [--qa-arms off,on-a] [--no-qa]
 *   bun eval/runner/chronicle-lift.ts score --out <dir> [--review <review.json>]
 *
 * Paid work: the ON arms' judge calls (gbrain's own chat model, metered
 * through a local proxy) and the agent's model calls all pass the budget
 * ledger's paid-request guard. The OFF arm and the corpus step make no paid
 * request. gbrain's MCP server runs with no provider key, so the agent's
 * searches are keyword-only in both arms.
 */
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun, type PaidRequestGuard } from './budget-ledger.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MeteringProxy, McpClient, newMeter, type Meter } from './cat40/gbrain-arm.ts';
import { runAgent, type Arm, type SubmitPayload, type ToolSpec } from './cat40/loop.ts';

export const LIFT_VERSION = 'chronicle-lift-v1';
const REPO = resolve(import.meta.dir, '../..');
const CORPUS = join(REPO, 'eval/data/amara-life-v1');
const LABELS = join(REPO, 'eval/data/chronicle-lift-v1');
const GBRAIN = join(REPO, 'node_modules/gbrain');

// ─── Corpus rendering (deterministic) ───────────────────────────────

interface Contact { name: string; slug: string }
const CONTACTS: Contact[] = [
  'Mina Kapoor', 'Priya Patel', 'Marcus Reid', 'Sarah Chen', 'Jordan Park', 'Hannah Liu', 'Diego Alvarez', 'Elena Rossi',
  'Kofi Mensah', 'Ravi Gupta', 'Lena Park', 'Tomoko Sato', 'Bill Hart', 'Nadia Freeman', 'Anna Petrov',
].map(name => ({ name, slug: `people/${name.toLowerCase().replace(/ /g, '-')}` }));
const personSlug = (name: string) => name === 'Amara Okafor' ? 'user/amara-okafor' : CONTACTS.find(c => c.name === name)?.slug ?? `people/${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;
const yamlList = (xs: string[]) => `[${xs.join(', ')}]`;
const icsTime = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:00Z`;

/** Every page of the world as vault-relative path and content. */
export function renderCorpus(corpusDir = CORPUS): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const f of readdirSync(join(corpusDir, 'meetings')).sort()) out.push({ path: `meetings/${f}`, content: readFileSync(join(corpusDir, 'meetings', f), 'utf8') });
  for (const f of readdirSync(join(corpusDir, 'notes')).sort()) out.push({ path: `notes/${f}`, content: readFileSync(join(corpusDir, 'notes', f), 'utf8') });
  for (const f of readdirSync(join(corpusDir, 'doc')).sort()) out.push({ path: `doc/${f}`, content: readFileSync(join(corpusDir, 'doc', f), 'utf8') });
  const ics = readFileSync(join(corpusDir, 'calendar.ics'), 'utf8');
  for (const block of ics.split('BEGIN:VEVENT').slice(1)) {
    const field = (k: string) => new RegExp(`^${k}[^:\\n]*:(.*)$`, 'm').exec(block)?.[1]?.trim() ?? '';
    const uid = field('UID').split('@')[0];
    const start = icsTime(field('DTSTART')); const end = icsTime(field('DTEND'));
    const summary = field('SUMMARY'); const location = field('LOCATION');
    const attendees = [...block.matchAll(/ATTENDEE;CN=([^:]+):/g)].map(m => m[1]);
    const body = `Calendar invite: ${summary}, ${start.slice(0, 10)} ${start.slice(11, 16)} to ${end.slice(11, 16)} UTC, with ${attendees.join(' and ')}.${location ? ` Location: ${location}.` : ''}\n`;
    out.push({ path: `cal/${uid}.md`, content: `---\ntitle: ${JSON.stringify(summary)}\ntype: calendar-event\ndate: ${start.slice(0, 10)}\nstart: ${start}\nend: ${end}\nattendees: ${yamlList(attendees.map(personSlug))}\n${location ? `location: ${JSON.stringify(location)}\n` : ''}---\n${body}` });
  }
  const slack = readFileSync(join(corpusDir, 'slack/messages.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { ts: string; channel: string; user: { name: string }; text: string });
  const groups = new Map<string, typeof slack>();
  for (const m of slack) { const k = `${m.channel}|${m.ts.slice(0, 10)}`; groups.set(k, [...(groups.get(k) ?? []), m]); }
  for (const [k, msgs] of [...groups.entries()].sort()) {
    const [channel, day] = k.split('|');
    msgs.sort((a, b) => a.ts.localeCompare(b.ts));
    const people = [...new Set(msgs.map(m => m.user.name))];
    const lines = msgs.map(m => `**${m.user.name}** (${m.ts.slice(0, 10)} ${m.ts.slice(11, 16)} UTC): ${m.text}`);
    out.push({ path: `conversations/slack-${channel.slice(1)}-${day}.md`, content: `---\ntitle: ${JSON.stringify(`${channel} on ${day}`)}\ntype: conversation\ndate: ${day}\nchannel: ${JSON.stringify(channel)}\nparticipants: ${yamlList(people.map(personSlug))}\n---\n${lines.join('\n')}\n` });
  }
  const emails = readFileSync(join(corpusDir, 'inbox/emails.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { id: string; ts: string; from: { name: string }; to: Array<{ name: string }>; subject: string; body_text: string });
  for (const e of emails) {
    out.push({ path: `emails/${e.id}.md`, content: `---\ntitle: ${JSON.stringify(e.subject)}\ntype: email\ndate: ${e.ts.slice(0, 10)}\nfrom: ${JSON.stringify(e.from.name)}\nto: ${yamlList(e.to.map(t => JSON.stringify(t.name)))}\n---\nFrom: ${e.from.name}\nTo: ${e.to.map(t => t.name).join(', ')}\nSent: ${e.ts.slice(0, 16).replace('T', ' ')} UTC\n\n${e.body_text}\n` });
  }
  return out;
}

export function corpusDigest(pages: Array<{ path: string; content: string }>): string {
  const h = createHash('sha256');
  for (const p of [...pages].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${p.path}\0${p.content}\0`);
  return h.digest('hex');
}

export const CHRONICLE_PREFIXES = ['meetings/', 'cal/', 'conversations/'];

// ─── Scoring (pure, exported for tests) ─────────────────────────────

export interface GoldEvent { id: string; day: string; kind: string; keywords: string[]; basis: string }
export interface GoldPage { slug: string; class: 'meeting' | 'calendar'; page_date: string; events: GoldEvent[] }
export interface Extracted { slug: string; depth: string; day: string; what: string; kind: string; who: string[] }

/** Maximum bipartite matching of extracted to expected events on one page (day equal, a keyword in the summary). */
export function matchPage(gold: GoldEvent[], extracted: Extracted[]): Array<[number, number]> {
  const ok = (g: GoldEvent, e: Extracted) => g.day === e.day && g.keywords.some(k => e.what.toLowerCase().includes(k.toLowerCase()));
  const matchOfExtracted = new Array<number>(extracted.length).fill(-1);
  const tryAssign = (gi: number, seen: boolean[]): boolean => {
    for (let ei = 0; ei < extracted.length; ei++) {
      if (seen[ei] || !ok(gold[gi], extracted[ei])) continue;
      seen[ei] = true;
      if (matchOfExtracted[ei] < 0 || tryAssign(matchOfExtracted[ei], seen)) { matchOfExtracted[ei] = gi; return true; }
    }
    return false;
  };
  for (let gi = 0; gi < gold.length; gi++) tryAssign(gi, new Array(extracted.length).fill(false));
  return matchOfExtracted.map((gi, ei) => [gi, ei] as [number, number]).filter(([gi]) => gi >= 0);
}

export interface QuestionDoc {
  contacts_first_names: string[];
  questions: Array<{ id: string; type: string; question: string; answer_kind: 'names' | 'date' | 'keywords' | 'unknown'; gold: unknown }>;
}

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** Deterministic answer scoring, as the question file's `scoring` block states. */
export function scoreAnswer(q: QuestionDoc['questions'][number], final: SubmitPayload | null, contacts: string[]): boolean {
  if (!final) return false;
  const answer = [final.answer ?? '', ...Object.values(final.fields ?? {})].join(' ');
  const dates = [...new Set(answer.match(DATE_RE) ?? [])];
  const word = (text: string, w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  switch (q.answer_kind) {
    case 'date': return dates.length === 1 && dates[0] === q.gold;
    case 'unknown': return /\bUNKNOWN\b/i.test(answer) && dates.length === 0;
    case 'names': {
      const gold = q.gold as string[];
      const named = contacts.filter(n => word(answer, n));
      return gold.every(n => named.includes(n)) && named.every(n => gold.includes(n));
    }
    case 'keywords': {
      const text = `${answer} ${final.notes ?? ''}`.toLowerCase();
      return (q.gold as string[][]).every(group => group.some(alt => text.includes(alt.toLowerCase())));
    }
  }
}

/** Paired bootstrap over questions of mean(on) - mean(off); per-question scores are means over repeats. */
export function pairedBootstrap(off: number[], on: number[], resamples = 10_000, seed = 20261004): { diff: number; lo: number; hi: number } {
  if (off.length !== on.length || off.length === 0) throw new Error('paired arrays must have the same nonzero length');
  const n = off.length;
  const d = off.map((o, i) => on[i] - o);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) { let acc = 0; for (let i = 0; i < n; i++) acc += d[Math.floor(rnd() * n)]; stats.push(acc / n); }
  stats.sort((a, b) => a - b);
  return { diff: mean(d), lo: stats[Math.floor(0.025 * resamples)], hi: stats[Math.floor(0.975 * resamples) - 1] };
}

/** Draw k distinct indices from 0..n-1 with Mulberry32 (partial Fisher-Yates); used for the preregistered Slack review sample. */
export function sampleIndices(n: number, k: number, seed: number): number[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < Math.min(k, n); i++) { const j = i + Math.floor(rnd() * (n - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, Math.min(k, n));
}
export const SLACK_SAMPLE = { size: 25, seed: 4 };

// ─── Brains ─────────────────────────────────────────────────────────

type ArmId = 'off' | 'on-a' | 'on-b';
const KEYLESS = (home: string): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: join(home, 'uh'), GBRAIN_HOME: join(home, 'home'), TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: 'off' });

function cli(env: Record<string, string>, args: string[], timeoutMs = 1_800_000): { code: number; stdout: string; stderr: string; ms: number } {
  const t = Date.now();
  const r = spawnSync('bun', [join(GBRAIN, 'src/cli.ts'), ...args], { env, cwd: env.GBRAIN_HOME, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - t };
}
const cliAsync = (env: Record<string, string>, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string; ms: number }>(resolveP => {
  const t = Date.now();
  const p = Bun.spawn(['bun', join(GBRAIN, 'src/cli.ts'), ...args], { env, cwd: env.GBRAIN_HOME, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([stdout, stderr, code]) => resolveP({ code, stdout, stderr, ms: Date.now() - t }));
});

interface BuildRecord { arm: ArmId; steps: Array<{ step: string; code: number; ms: number; tail: string }>; phase_runs: unknown[]; meter: Meter; judged: number; spent_usd_recorded: number; events: Extracted[]; ledger_rows: unknown[]; ms: number }

async function buildBrain(arm: ArmId, dir: string, vault: string, proxy: MeteringProxy | null): Promise<BuildRecord> {
  const t0 = Date.now();
  rmSync(dir, { recursive: true, force: true });
  for (const d of ['home', 'uh']) mkdirSync(join(dir, d), { recursive: true });
  const env = KEYLESS(dir);
  const steps: BuildRecord['steps'] = [];
  const step = (name: string, args: string[]) => {
    const r = cli(env, args);
    steps.push({ step: name, code: r.code, ms: r.ms, tail: (r.stdout + '\n' + r.stderr).split('\n').filter(l => l.trim()).slice(-6).join('\n') });
    if (r.code !== 0) throw new Error(`${arm}: gbrain ${name} failed (exit ${r.code}): ${steps.at(-1)!.tail}`);
    return r;
  };
  step('init', ['init', '--pglite', '--non-interactive', '--no-embedding']);
  step('recent-days', ['config', 'set', 'chronicle.auto_recent_days', '365']);
  step('settle', ['config', 'set', 'chronicle.auto_settle_seconds', '0']);
  if (arm === 'off') step('auto-chronicle-off', ['config', 'set', 'auto_chronicle', 'false']);
  step('import', ['import', vault, '--no-embed', '--json']);
  const phaseEnv: Record<string, string> = { ...env };
  if (proxy) {
    phaseEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
    phaseEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}/${arm}/anthropic`;
    proxy.bind(arm, `build:${arm}`);
  }
  const phaseRuns: unknown[] = [];
  let judged = 0; let spent = 0;
  for (let i = 0; i < 12; i++) {
    const r = await cliAsync(phaseEnv, ['dream', '--phase', 'chronicle', '--json']);
    let phase: any = null;
    try { phase = JSON.parse(r.stdout).phases?.[0] ?? null; } catch { /* recorded raw */ }
    phaseRuns.push(phase ?? { code: r.code, stdout_tail: r.stdout.slice(-1500), stderr_tail: r.stderr.slice(-1500) });
    steps.push({ step: `phase-${i + 1}`, code: r.code, ms: r.ms, tail: phase?.summary ?? r.stderr.split('\n').slice(-3).join('\n') });
    judged += Number(phase?.details?.judged ?? 0);
    spent += Number(phase?.details?.spent_usd ?? 0);
    if (r.code !== 0 || !phase || Number(phase.details?.candidates ?? 0) === 0 || Number(phase.details?.judged ?? 0) === 0) break;
  }
  const meter = proxy ? (proxy.unbind(arm), await proxy.finalize(`build:${arm}`)) : newMeter();
  const { events, ledgerRows } = await readEvents(env);
  return { arm, steps, phase_runs: phaseRuns, meter, judged, spent_usd_recorded: spent, events, ledger_rows: ledgerRows, ms: Date.now() - t0 };
}

async function readEvents(env: Record<string, string>): Promise<{ events: Extracted[]; ledgerRows: unknown[] }> {
  const script = `
    const { PGLiteEngine } = await import(${JSON.stringify(join(GBRAIN, 'src/core/pglite-engine.ts'))});
    const cfg = JSON.parse(await Bun.file(${JSON.stringify(join(env.GBRAIN_HOME, '.gbrain', 'config.json'))}).text());
    const e = new PGLiteEngine(); await e.connect({ database_path: cfg.database_path });
    const pages = await e.executeRaw("SELECT slug, frontmatter FROM pages WHERE type = 'event' AND deleted_at IS NULL ORDER BY slug");
    const ledger = await e.executeRaw("SELECT p.slug, s.* FROM chronicle_page_state s JOIN pages p ON p.id = s.page_id ORDER BY p.slug");
    await e.disconnect();
    console.log(JSON.stringify({ pages, ledger }));`;
  const r = spawnSync('bun', ['-e', script], { env: { ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`reading events failed: ${r.stderr.slice(-800)}`);
  const parsed = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
  const events: Extracted[] = (parsed.pages as Array<{ slug: string; frontmatter: any }>).map(p => {
    const fm = typeof p.frontmatter === 'string' ? JSON.parse(p.frontmatter) : p.frontmatter;
    const ev = fm?.event ?? {};
    return { slug: p.slug, depth: String(ev.depth ?? ''), day: p.slug.replace(/^life\/events\//, '').slice(0, 10), what: String(ev.what ?? ''), kind: String(ev.kind ?? ''), who: Array.isArray(ev.who) ? ev.who : [] };
  });
  return { events, ledgerRows: parsed.ledger };
}

// ─── Agent arm over gbrain's MCP server ─────────────────────────────

class GbrainMcpArm implements Arm {
  readonly name = 'gbrain';
  client: McpClient;
  constructor(private home: string) { this.client = new McpClient({ buildDir: GBRAIN, env: KEYLESS(home) }, []); }
  async start() { await this.client.start(); }
  async stop() { await this.client.close(); }
  systemHint() { return `The knowledge base is Amara's gbrain, reached through the MCP tools listed. The gbrain server's instructions follow.\n<mcp_server_instructions server="gbrain">\n${this.client.instructions}\n</mcp_server_instructions>`; }
  tools(): ToolSpec[] { return this.client.tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> })); }
  writeTools() { return this.client.tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name); }
  call(name: string, args: Record<string, unknown>) { return this.client.call(name, args); }
}

export function systemPrompt(arm: Arm, today: string): string {
  return [
    `You are an AI assistant working for Amara Okafor, a partner at Halfway Capital. Today is ${today}. All dates are UTC.`,
    "Answer using Amara's knowledge base available through your tools. Do not guess.",
    arm.systemHint(),
    'When you are done, call submit_answer with the value only in `answer`, the ids or paths of the documents you relied on in `sources`, and any caveats in `notes`. Write dates as YYYY-MM-DD.',
    'If the knowledge base does not contain the answer, answer UNKNOWN.',
  ].join('\n\n');
}

// ─── Commands ───────────────────────────────────────────────────────

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const git = (...a: string[]) => { try { return execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };

function writeVault(out: string): { vault: string; digest: string; pages: number; chronicle_shaped: number } {
  const pages = renderCorpus();
  const vault = join(out, 'vault');
  rmSync(vault, { recursive: true, force: true });
  for (const p of pages) { mkdirSync(dirname(join(vault, p.path)), { recursive: true }); writeFileSync(join(vault, p.path), p.content); }
  return { vault, digest: corpusDigest(pages), pages: pages.length, chronicle_shaped: pages.filter(p => CHRONICLE_PREFIXES.some(x => p.path.startsWith(x))).length };
}

async function run(argv: string[]) {
  const out = resolve(flag(argv, '--out') ?? 'eval/reports/chronicle-lift/run');
  mkdirSync(out, { recursive: true });
  const arms = (flag(argv, '--arms') ?? 'off,on-a,on-b').split(',') as ArmId[];
  const qaArms = argv.includes('--no-qa') ? [] : (flag(argv, '--qa-arms') ?? 'off,on-a').split(',') as ArmId[];
  const repeats = Number(flag(argv, '--repeats') ?? 2);
  const model = flag(argv, '--model') ?? 'claude-sonnet-4-6';
  const maxTurns = Number(flag(argv, '--max-turns') ?? 12);
  const questionsDoc = JSON.parse(readFileSync(flag(argv, '--questions-file') ?? join(LABELS, 'questions.json'), 'utf8')) as QuestionDoc & { today: string };
  const only = flag(argv, '--questions')?.split(',');
  const questions = questionsDoc.questions.filter(q => !only || only.includes(q.id));
  const estimate = Number(flag(argv, '--estimate-usd') ?? 15);
  const corpus = writeVault(out);
  writeFileSync(join(out, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n');
  const paid = arms.length > 0 || qaArms.length > 0;
  let budget: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  if (paid) budget = startPaidRun(LIFT_VERSION, { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  const proxy = new MeteringProxy();
  proxy.start();
  const started = new Date().toISOString();
  const builds: Record<string, Omit<BuildRecord, 'events' | 'ledger_rows'> & { events: number }> = {};
  try {
    for (const arm of arms) {
      console.error(`[lift] building ${arm}`);
      const b = await buildBrain(arm, join(out, 'brains', arm), corpus.vault, proxy);
      writeFileSync(join(out, `events-${arm}.json`), JSON.stringify(b.events, null, 2) + '\n');
      writeFileSync(join(out, `ledger-${arm}.json`), JSON.stringify(b.ledger_rows, null, 2) + '\n');
      const { events, ledger_rows, ...rest } = b;
      builds[arm] = { ...rest, events: events.length };
      writeFileSync(join(out, `build-${arm}.json`), JSON.stringify(builds[arm], null, 2) + '\n');
      execFileSync('tar', ['-C', join(out, 'brains', arm), '-cf', join(out, 'brains', `${arm}.tar`), 'home']);
      console.error(`[lift] ${arm}: judged ${b.judged}, events ${events.length}, metered $${b.meter.usd.toFixed(4)}, recorded $${b.spent_usd_recorded.toFixed(4)}`);
    }
    const resultsPath = join(out, 'qa-results.jsonl');
    const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).key) : []);
    await Promise.all(qaArms.map(async arm => {
      const home = join(out, 'brains', arm);
      const restore = () => { rmSync(join(home, 'home'), { recursive: true, force: true }); execFileSync('tar', ['-C', home, '-xf', join(out, 'brains', `${arm}.tar`), 'home']); };
      restore();
      let agentArm = new GbrainMcpArm(home);
      await agentArm.start();
      try {
        for (let r = 1; r <= repeats; r++) {
          for (const q of questions) {
            const key = `${arm}|${q.id}|${r}`;
            if (done.has(key)) continue;
            if (budget?.guard.exhausted) throw new Error('budget exhausted');
            const res = await runAgent({ model, system: systemPrompt(agentArm, questionsDoc.today), user: q.question, arm: agentArm, maxTurns });
            const wrote = res.tools.some(t => agentArm.writeTools().includes(t.name) && t.name !== 'submit_answer');
            const correct = scoreAnswer(q, res.final, questionsDoc.contacts_first_names);
            const { tools, ...runRest } = res;
            appendFileSync(resultsPath, JSON.stringify({ key, arm, question: q.id, type: q.type, repeat: r, correct, final: res.final, wrote,
              run: { ...runRest, tool_calls: tools.map(t => ({ name: t.name, args: t.args, ms: t.ms, chars: t.chars, error: t.error })) } }) + '\n');
            console.error(`[lift] ${key}: ${correct ? 'correct' : 'wrong'} ($${res.usd.toFixed(4)}, ${res.turns} turns, ${res.stop})`);
            if (wrote) { await agentArm.stop(); restore(); agentArm = new GbrainMcpArm(home); await agentArm.start(); }
          }
        }
      } finally { await agentArm.stop(); }
    }));
  } finally {
    proxy.stop();
    const summary = budget ? (budget.guard.uninstall(), budget.run.close()) : null;
    const pkg = JSON.parse(readFileSync(join(GBRAIN, 'package.json'), 'utf8'));
    writeFileSync(join(out, 'receipt.json'), JSON.stringify({
      kind: LIFT_VERSION, started, finished: new Date().toISOString(), bun: Bun.version,
      gbrain: { version: pkg.version, declared_pin: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).dependencies.gbrain },
      gbrain_evals: { git_head: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '') !== '' },
      corpus: { digest: corpus.digest, pages: corpus.pages, chronicle_shaped: corpus.chronicle_shaped },
      settings: { arms, qa_arms: qaArms, repeats, model, max_turns: maxTurns, questions: questions.length, chronicle: { auto_recent_days: 365, auto_settle_seconds: 0, judge: 'gbrain default chat model (ANTHROPIC_API_KEY only)' }, embeddings: 'none (gbrain init --no-embedding; keyword search in every arm)', mcp: 'gbrain serve (default full surface), no provider key' },
      builds, cost: summary ? receiptCost(summary) : null,
    }, null, 2) + '\n');
  }
}

function score(argv: string[]) {
  const out = resolve(flag(argv, '--out') ?? 'eval/reports/chronicle-lift/run');
  const gold = JSON.parse(readFileSync(join(LABELS, 'gold-events.json'), 'utf8')) as { pages: GoldPage[] };
  const reviewPath = flag(argv, '--review');
  const review: Record<string, { class: string; note?: string }> = reviewPath ? JSON.parse(readFileSync(reviewPath, 'utf8')).events ?? {} : {};
  const questionsDoc = JSON.parse(readFileSync(join(LABELS, 'questions.json'), 'utf8')) as QuestionDoc;
  const result: Record<string, unknown> = {};
  for (const arm of ['on-a', 'on-b'] as const) {
    if (!existsSync(join(out, `events-${arm}.json`))) continue;
    const events = JSON.parse(readFileSync(join(out, `events-${arm}.json`), 'utf8')) as Extracted[];
    const build = JSON.parse(readFileSync(join(out, `build-${arm}.json`), 'utf8'));
    const ledger = JSON.parse(readFileSync(join(out, `ledger-${arm}.json`), 'utf8')) as Array<{ slug: string }>;
    const pageDate = new Map<string, string>();
    for (const f of readdirSync(join(out, 'vault'), { recursive: true }) as string[]) {
      if (!f.endsWith('.md')) continue;
      const m = /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(readFileSync(join(out, 'vault', f), 'utf8'));
      if (m) pageDate.set(f.replace(/\.md$/, ''), m[1]);
    }
    const perClass: Record<string, { pages: number; expected: number; matched: number; events: number }> = {};
    const unmatched: Array<Extracted & { page_date: string; premature: boolean; review?: string }> = [];
    let expected = 0, matched = 0;
    for (const g of gold.pages) {
      const mine = events.filter(e => e.depth === g.slug);
      const pairs = matchPage(g.events, mine);
      const c = (perClass[g.class] ??= { pages: 0, expected: 0, matched: 0, events: 0 });
      c.pages++; c.expected += g.events.length; c.matched += pairs.length; c.events += mine.length;
      expected += g.events.length; matched += pairs.length;
      const used = new Set(pairs.map(([, ei]) => ei));
      mine.forEach((e, i) => { if (!used.has(i)) unmatched.push({ ...e, page_date: g.page_date, premature: e.day > g.page_date, review: review[e.slug]?.class }); });
    }
    const conv = events.filter(e => e.depth.startsWith('conversations/'));
    const convPremature = conv.filter(e => e.day > (pageDate.get(e.depth) ?? '9999'));
    const convCandidates = conv.filter(e => !convPremature.includes(e)).sort((a, b) => a.slug.localeCompare(b.slug));
    const sample = sampleIndices(convCandidates.length, SLACK_SAMPLE.size, SLACK_SAMPLE.seed).map(i => ({ ...convCandidates[i], page_date: pageDate.get(convCandidates[i].depth), review: review[convCandidates[i].slug]?.class }));
    const controls = ledger.filter(r => !CHRONICLE_PREFIXES.some(p => r.slug.startsWith(p)));
    const labeledPremature = unmatched.filter(u => u.premature).length;
    const labeledFalse = unmatched.filter(u => !u.premature && u.review === 'false').length;
    const unreviewed = unmatched.filter(u => !u.premature && !u.review).length;
    result[arm] = {
      judged_pages: build.judged, events_written: events.length, events_per_judged_page: build.judged ? events.length / build.judged : null,
      cost: { metered_usd: build.meter.usd, recorded_usd: build.spent_usd_recorded, per_judged_page_metered: build.judged ? build.meter.usd / build.judged : null, by_model: build.meter.byModel, unpriced: build.meter.unpriced },
      labeled: { pages: gold.pages.length, expected, matched, recall: expected ? matched / expected : null, per_class: perClass,
        unmatched: unmatched.length, premature: labeledPremature, false: labeledFalse, duplicate: unmatched.filter(u => u.review === 'duplicate').length,
        supported: unmatched.filter(u => u.review === 'supported').length, unreviewed,
        false_plus_premature_per_judged_labeled_page: (labeledFalse + labeledPremature) / gold.pages.length },
      conversations: { pages_with_events: new Set(conv.map(e => e.depth)).size, events: conv.length, premature: convPremature.length,
        sample: { size: sample.length, false: sample.filter(x => x.review === 'false').length, duplicate: sample.filter(x => x.review === 'duplicate').length, supported: sample.filter(x => x.review === 'supported').length, unreviewed: sample.filter(x => !x.review).length } },
      conversation_sample: sample,
      controls_judged: controls.length,
      unmatched_labeled: unmatched,
    };
  }
  const qaPath = join(out, 'qa-results.jsonl');
  if (existsSync(qaPath)) {
    const rows = readFileSync(qaPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) as Array<{ arm: string; question: string; type: string; repeat: number; final: SubmitPayload | null; run: { usd: number; stop: string } }>;
    const byArm: Record<string, Record<string, number[]>> = {};
    for (const r of rows) {
      const q = questionsDoc.questions.find(x => x.id === r.question);
      if (!q) continue;
      ((byArm[r.arm] ??= {})[r.question] ??= []).push(scoreAnswer(q, r.final, questionsDoc.contacts_first_names) ? 1 : 0);
    }
    const ids = questionsDoc.questions.map(q => q.id).filter(id => byArm.off?.[id] && byArm['on-a']?.[id]);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const off = ids.map(id => mean(byArm.off[id])); const on = ids.map(id => mean(byArm['on-a'][id]));
    const types = [...new Set(questionsDoc.questions.map(q => q.type))];
    result.qa = {
      questions: ids.length, runs: rows.length,
      accuracy: { off: off.length ? mean(off) : null, on: on.length ? mean(on) : null },
      lift: ids.length ? pairedBootstrap(off, on) : null,
      by_type: Object.fromEntries(types.map(t => { const tid = ids.filter(id => questionsDoc.questions.find(q => q.id === id)!.type === t); return [t, { questions: tid.length, off: tid.length ? mean(tid.map(id => mean(byArm.off[id]))) : null, on: tid.length ? mean(tid.map(id => mean(byArm['on-a'][id]))) : null }]; })),
      per_question: Object.fromEntries(ids.map((id, i) => [id, { off: off[i], on: on[i] }])),
      usd: Object.fromEntries(Object.keys(byArm).map(a => [a, rows.filter(r => r.arm === a).reduce((s, r) => s + r.run.usd, 0)])),
      stops: Object.fromEntries(Object.keys(byArm).map(a => [a, rows.filter(r => r.arm === a).reduce((m, r) => ({ ...m, [r.run.stop]: (m[r.run.stop] ?? 0) + 1 }), {} as Record<string, number>)])),
    };
  }
  writeFileSync(join(out, 'scores.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, (k, v) => k === 'unmatched_labeled' || k === 'per_question' || k === 'conversation_sample' ? undefined : v, 2));
}

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === 'corpus') {
    const out = resolve(flag(argv, '--out') ?? 'eval/reports/chronicle-lift/corpus');
    mkdirSync(out, { recursive: true });
    console.log(JSON.stringify(writeVault(out), null, 2));
  } else if (cmd === 'run') await run(argv);
  else if (cmd === 'score') score(argv);
  else { console.error('usage: chronicle-lift.ts corpus|run|score --out <dir> [...]'); process.exit(2); }
}
