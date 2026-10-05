/**
 * P8 quote grounding (dev): does `gbrain think` keep supported quotes and catch
 * unsupported ones?
 *
 * Each question targets one page of a corpus, imported into an in-memory
 * PGLite brain with real embeddings:
 *   amara                the amara-life-v1 world (rendered as in chronicle-lift), one brain for all its questions
 *   sealed-confirmation  a sealed-confirmation set's haystacks (custodian only): one brain per haystack a
 *                        question names, each session one page `chats/<session_id>`, rendered the way
 *                        gbrain's LongMemEval adapter renders a session
 * Each question goes through the build's runThink with think.quote_verify on;
 * the runner captures the exact prompt the model saw (runThink's client seam),
 * so the judge sees the delivered evidence, not the whole corpus. Every quoted
 * span in what the model wrote (`answer_raw`, or `answer` when nothing was
 * quoted) is labelled by an independent judge model: verbatim, close (same
 * words with small differences) or unsupported. gbrain's own verdict per span
 * is `flagged` when the span is in `unverified_quotes`, else `kept`.
 *
 * Reported: supported spans wrongly flagged (rate, Wilson 95% upper bound),
 * unsupported spans kept, counts by question.
 *
 * Usage (dev; amara corpus, dev seed 1 only):
 *   bun eval/runner/p8-quote-grounding.ts --gbrain <checkout>@<ref> [--questions eval/data/p8-quote-grounding/dev-questions.json]
 *     [--think-model anthropic:claude-sonnet-5-5] [--judge gpt-6.1-sol] [--limit <n>] [--replay <rows.ndjson>] --out eval/reports/p8-quote-grounding/<name>
 *   bun eval/runner/p8-quote-grounding.ts --make-questions --n 50 --seed 1 --out-questions <file> [--model gpt-6.1-sol]
 *
 * Custodian (held-out) mode. Every custody path must be outside the repository;
 * each read appends a line to access-log.jsonl beside the file before its bytes
 * are parsed, and summaries record SHA-256 values, never custody paths or text.
 *   bun eval/runner/p8-quote-grounding.ts --make-questions --corpus amara|sealed-confirmation [--corpus-dir <custody dir>]
 *     [--corpus-manifest <manifest.json>] --n <n> --seed <held-out seed, not 1> --out-questions <custody file>
 *     --decision-id <id> --purpose <text> [--model gpt-6.1-sol]
 *   bun eval/runner/p8-quote-grounding.ts --gbrain <checkout>@<ref> --heldout-questions <custody file>
 *     [--corpus-dir <custody dir>] [--corpus-manifest <manifest.json>] --decision-id <id> --purpose <text>
 *     --out <dir outside the repository> [--think-model ...] [--judge ...] [--replay <rows.ndjson>]
 * On amara, held-out questions are drawn only from pages no dev question uses.
 * Writing a held-out questions file appends a `write` line with its SHA-256 to
 * access-log.jsonl beside it.
 *
 * Sealed-confirmation corpus directory (custody): `questions.json` in the
 * `sealed-confirmation-questions-v1` schema of sealed-confirmation-lib.ts
 * ({ schema, set_id, haystacks: [{ haystack_id, sessions: [{ session_id, date,
 * turns: [{ role, content }] }] }], questions }), checked against the input
 * allowlist and, with --corpus-manifest, against the manifest's questions.json
 * commitment. Only the haystacks are used; `labels.json` is never opened.
 *
 * Questions file (dev or custody):
 *   { "generator": "p8-quote-grounding@2", "corpus": "amara" | "sealed-confirmation", "seed": <n>, "model": "...",
 *     "corpus_sha256": "<questions.json sha256, sealed only>",
 *     "questions": [{ "id": "q000", "corpus": "amara" | "sealed-confirmation", "haystack": "<haystack_id, sealed only>",
 *                     "page": "<amara path like notes/x.md, or chats/<session_id>>", "kind": "quote" | "natural",
 *                     "question": "..." }] }
 * A question without `corpus` targets amara (the generator@1 dev file).
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { renderCorpus } from './chronicle-lift.ts';
import { importGbrain, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { ChatClient } from './memory-qa/qa.ts';
import {
  appendAccessLog, assertOutsideRepository, openCustodyFile, sha256Hex, validateQuestionsFile,
  type HaystackSession, type QuestionsFile,
} from './sealed-confirmation-lib.ts';
import { Rng } from '../generators/seeded.ts';

const log = (s: string) => process.stderr.write(`[quotes] ${s}\n`);

export const QUESTIONS_GENERATOR = 'p8-quote-grounding@2';
export const DEV_SEEDS: readonly number[] = [1];
export const DEV_QUESTIONS = 'eval/data/p8-quote-grounding/dev-questions.json';
export const CORPORA = ['amara', 'sealed-confirmation'] as const;
export type CorpusName = typeof CORPORA[number];

export interface Question { id: string; corpus: CorpusName; haystack?: string; page: string; kind: 'quote' | 'natural'; question: string }
export interface QuestionsDoc { generator: string; corpus?: CorpusName; seed: number; model: string; corpus_sha256?: string; questions: Question[] }
export interface CorpusPage { corpus: CorpusName; haystack?: string; page: string; slug: string; content: string }

export function amaraPages(): CorpusPage[] {
  return renderCorpus().map(p => ({ corpus: 'amara', page: p.path, slug: p.path.replace(/\.md$/, ''), content: p.content }));
}

/** One chat session as a page, in the shape gbrain's LongMemEval adapter writes (note frontmatter, `**role:** text` turns). */
export function renderSession(s: HaystackSession): string {
  const fm = ['---', 'type: note', ...(s.date ? [`date: ${s.date}`] : []), `session_id: ${s.session_id}`, '---', ''];
  return fm.join('\n') + s.turns.map(t => `**${t.role}:** ${t.content}\n`).join('\n');
}

export function sealedPages(q: QuestionsFile): CorpusPage[] {
  return q.haystacks.flatMap(h => h.sessions.map(s => ({ corpus: 'sealed-confirmation' as const, haystack: h.haystack_id, page: `chats/${s.session_id}`, slug: `chats/${s.session_id}`, content: renderSession(s) })));
}

/** Parse sealed-confirmation questions.json bytes: optional manifest commitment, then the input allowlist. Problems name fields, never content. */
export function parseSealedCorpus(bytes: Buffer, manifest?: { commitments?: Record<string, { sha256: string; bytes: number }> }): QuestionsFile {
  if (manifest) {
    const c = manifest.commitments?.['questions.json'];
    if (!c) throw new Error('--corpus-manifest has no questions.json commitment');
    if (c.sha256 !== sha256Hex(bytes) || c.bytes !== bytes.length) throw new Error('sealed-confirmation questions.json does not match the manifest commitment');
  }
  const q = JSON.parse(bytes.toString('utf8'));
  const problems = validateQuestionsFile(q);
  if (problems.length) throw new Error(`sealed-confirmation questions.json rejected:\n${problems.slice(0, 20).join('\n')}`);
  return q;
}

/** Custodian read of a sealed-confirmation corpus directory: access-logged, hashed, never touching labels.json. */
export function openSealedCorpus(o: { dir: string; manifest?: string; decisionId?: string; purpose?: string }): { pages: CorpusPage[]; sha256: string } {
  const { bytes, sha256 } = openCustodyFile({ file: join(o.dir, 'questions.json'), flag: '--corpus-dir', decisionId: o.decisionId, purpose: o.purpose });
  const file = parseSealedCorpus(bytes, o.manifest ? JSON.parse(readFileSync(o.manifest, 'utf8')) : undefined);
  return { pages: sealedPages(file), sha256 };
}

/** Normalize and check a questions file against the pages it targets. */
export function parseQuestions(raw: unknown): QuestionsDoc {
  const doc = raw as QuestionsDoc;
  if (!doc || !Array.isArray(doc.questions) || typeof doc.seed !== 'number') throw new Error('questions file needs a numeric seed and a questions array');
  const ids = new Set<string>();
  doc.questions = doc.questions.map((q, i) => {
    const corpus = (q.corpus ?? 'amara') as CorpusName;
    if (!CORPORA.includes(corpus)) throw new Error(`questions[${i}]: corpus must be ${CORPORA.join(' or ')}`);
    if (corpus === 'sealed-confirmation' && !q.haystack) throw new Error(`questions[${i}]: a sealed-confirmation question names its haystack`);
    if (!q.id || ids.has(q.id) || !q.page || !q.question || (q.kind !== 'quote' && q.kind !== 'natural')) throw new Error(`questions[${i}]: needs a unique id, page, question and kind quote|natural`);
    ids.add(q.id);
    return { ...q, corpus };
  });
  return doc;
}

export function assertPagesExist(questions: readonly Question[], pages: readonly CorpusPage[]): void {
  const have = new Set(pages.map(p => `${p.corpus}|${p.haystack ?? ''}|${p.page}`));
  const missing = questions.filter(q => !have.has(`${q.corpus}|${q.haystack ?? ''}|${q.page}`)).map(q => q.id);
  if (missing.length) throw new Error(`${missing.length} question(s) target a page missing from their corpus: ${missing.slice(0, 10).join(', ')}`);
}

const ASK = {
  amara: {
    quote: 'Write one question a user would ask their memory assistant about this document that is best answered by quoting what someone said or wrote, word for word (for example "What exactly did X say about Y?"). Name the people or topic so the question stands alone without the document.',
    natural: 'Write one natural question a user would ask their memory assistant that this document answers. Name the people or topic so the question stands alone without the document.',
  },
  'sealed-confirmation': {
    quote: 'This is one past conversation between a user and an assistant. Write one question the user would later ask their memory assistant that is best answered by quoting, word for word, what was said in it (for example "What exactly did I say about Y?" or "What exactly did you tell me about Z?"). Name the topic so the question stands alone without the conversation.',
    natural: 'This is one past conversation between a user and an assistant. Write one natural question the user would later ask their memory assistant that this conversation answers. Name the topic so the question stands alone without the conversation.',
  },
} as const;

/** Draw n pages with the seed (70% quote-eliciting, the rest natural) and ask the model for one question each. */
export async function makeQuestions(o: { pages: readonly CorpusPage[]; corpus: CorpusName; n: number; seed: number; model: string; ask: (model: string, prompt: string) => Promise<string>; exclude?: ReadonlySet<string> }): Promise<Question[]> {
  const pool = o.pages.filter(p => p.corpus === o.corpus && !o.exclude?.has(p.page) && (o.corpus !== 'amara' || /^(meetings|conversations|emails|notes)\//.test(p.page)));
  const picked = new Rng(o.seed).shuffle(pool).slice(0, o.n);
  const qs: Question[] = [];
  for (const [i, p] of picked.entries()) {
    const kind = i < Math.round(o.n * 0.7) ? 'quote' : 'natural';
    const text = await o.ask(o.model, `${ASK[o.corpus][kind]}\nReply with the question only.\n\n<document path="${p.page}">\n${p.content.slice(0, 6000)}\n</document>`);
    qs.push({ id: `q${String(i).padStart(3, '0')}`, corpus: o.corpus, ...(p.haystack ? { haystack: p.haystack } : {}), page: p.page, kind, question: text.trim().replace(/^"|"$/g, '') });
  }
  return qs;
}

/** Quoted spans of at least three words: curly pairs, and straight quotes paired in order within a line. */
export function quoteSpans(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]*)"|“([^”\n]*)”/g)) {
    const inner = (m[1] ?? m[2] ?? '').trim();
    if (inner.length >= 8 && inner.split(/\s+/).length >= 3) out.push(inner);
  }
  return out;
}

function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n === 0) return 1;
  const p = k / n, d = 1 + z * z / n;
  return (p + z * z / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
}

async function judge(chat: ChatClient, model: string, evidence: string, span: string): Promise<'verbatim' | 'close' | 'unsupported'> {
  const prompt = `You check quotations against evidence. Below is the evidence an assistant was given, then one quotation from its answer.
Label the quotation:
- verbatim: the evidence contains these exact words (ignore case, punctuation, whitespace and markdown link syntax like [Name](path)).
- close: the evidence contains nearly these words (a few words differ or are elided) with the same meaning, said by the same person.
- unsupported: the evidence does not contain these words or a near-identical passage.
Reply with one word: verbatim, close or unsupported.

<evidence>
${evidence}
</evidence>

<quotation>${span}</quotation>`;
  const r = await chat.chat(model, prompt, { maxTokens: 20, replicate: 0 });
  const w = r.text.trim().toLowerCase();
  return w.startsWith('verbatim') ? 'verbatim' : w.startsWith('close') ? 'close' : 'unsupported';
}

const flagOf = (argv: readonly string[]) => (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** Custodian or dev setup shared by both subcommands: which pages exist, and what the summary may record about them. */
function corpusPages(f: (n: string) => string | undefined, custodian: boolean, needSealed: boolean): { pages: CorpusPage[]; sealedSha256: string | null } {
  const pages = amaraPages();
  if (!needSealed) {
    if (f('--corpus-dir')) throw new Error('--corpus-dir is only for the sealed-confirmation corpus');
    return { pages, sealedSha256: null };
  }
  if (!custodian) throw new Error('the sealed-confirmation corpus is custodian-only: pass --decision-id and --purpose with custody paths outside the repository');
  const dir = f('--corpus-dir');
  if (!dir) throw new Error('the sealed-confirmation corpus needs --corpus-dir <custody dir holding questions.json>');
  const sealed = openSealedCorpus({ dir, manifest: f('--corpus-manifest'), decisionId: f('--decision-id'), purpose: f('--purpose') });
  return { pages: [...pages, ...sealed.pages], sealedSha256: sealed.sha256 };
}

async function makeQuestionsCli(argv: readonly string[]) {
  const f = flagOf(argv);
  const corpus = (f('--corpus') ?? 'amara') as CorpusName;
  if (!CORPORA.includes(corpus)) throw new Error(`--corpus must be ${CORPORA.join(' or ')}`);
  const seed = Number(f('--seed') ?? DEV_SEEDS[0]);
  const out = f('--out-questions');
  if (!out) throw new Error('--make-questions needs --out-questions <file>');
  const custodian = f('--decision-id') !== undefined || f('--purpose') !== undefined || corpus !== 'amara';
  if (custodian) {
    if (!f('--decision-id')?.trim() || !f('--purpose')?.trim()) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log');
    if (DEV_SEEDS.includes(seed)) throw new Error(`custodian mode needs a held-out seed; ${DEV_SEEDS.join(', ')} are development seeds`);
    assertOutsideRepository(out, '--out-questions');
  } else if (!DEV_SEEDS.includes(seed)) {
    throw new Error(`only dev seeds ${DEV_SEEDS.join(', ')} run here; held-out questions belong to the custodian (--decision-id, --purpose, --out-questions outside the repository)`);
  }
  const { pages, sealedSha256 } = corpusPages(f, custodian, corpus === 'sealed-confirmation');
  const exclude = custodian && corpus === 'amara' ? new Set(parseQuestions(JSON.parse(readFileSync(DEV_QUESTIONS, 'utf8'))).questions.map(q => q.page)) : undefined;
  const model = f('--model') ?? 'gpt-6.1-sol';
  const cache = cacheDir(custodian);
  const chat = new ChatClient(cache);
  const questions = await makeQuestions({ pages, corpus, n: Number(f('--n') ?? 50), seed, model, exclude, ask: async (m, prompt) => (await chat.chat(m, prompt, { maxTokens: 300, replicate: 0 })).text });
  const text = JSON.stringify({ generator: QUESTIONS_GENERATOR, corpus, seed, model, ...(sealedSha256 ? { corpus_sha256: sealedSha256 } : {}), questions } satisfies QuestionsDoc, null, 2);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, text);
  if (custodian) appendAccessLog(join(dirname(resolve(out)), 'access-log.jsonl'), { action: 'write', purpose: f('--purpose')!, decision_id: f('--decision-id')!, labels_sha256: sha256Hex(text), run_sha256: null });
  log(`wrote ${questions.length} ${corpus} questions${custodian ? ` (sha256 ${sha256Hex(text)})` : ` to ${out}`}`);
}

function cacheDir(custodian: boolean): string {
  const dir = process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache');
  if (custodian) assertOutsideRepository(dir, 'GBRAIN_EVALS_QA_CACHE');
  return dir;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--make-questions')) return makeQuestionsCli(argv);
  const flag = flagOf(argv);
  const heldout = flag('--heldout-questions');
  let doc: QuestionsDoc;
  let questionsSha: string | null = null;
  if (heldout) {
    if (flag('--questions')) throw new Error('custodian mode reads --heldout-questions; drop --questions');
    if (!flag('--out')) throw new Error('custodian mode needs --out <dir outside the repository>: rows carry held-out questions and answers');
    assertOutsideRepository(flag('--out')!, '--out');
    if (flag('--replay')) assertOutsideRepository(flag('--replay')!, '--replay');
    const custody = openCustodyFile({ file: heldout, flag: '--heldout-questions', decisionId: flag('--decision-id'), purpose: flag('--purpose') });
    questionsSha = custody.sha256;
    doc = parseQuestions(JSON.parse(custody.bytes.toString('utf8')));
  } else {
    doc = parseQuestions(JSON.parse(readFileSync(flag('--questions') ?? DEV_QUESTIONS, 'utf8')));
    if (!DEV_SEEDS.includes(doc.seed)) throw new Error(`only dev seeds ${DEV_SEEDS.join(', ')} run here; held-out questions run in custodian mode (--heldout-questions)`);
  }
  const needSealed = doc.questions.some(q => q.corpus === 'sealed-confirmation');
  const { pages, sealedSha256 } = corpusPages(flag, heldout !== undefined, needSealed);
  if (doc.corpus_sha256 && doc.corpus_sha256 !== sealedSha256) throw new Error('the questions were drawn from a different sealed-confirmation questions.json than --corpus-dir holds');
  const questions = doc.questions.slice(0, flag('--limit') ? Number(flag('--limit')) : undefined);
  assertPagesExist(questions, pages);
  const out = resolve(flag('--out') ?? 'eval/reports/p8-quote-grounding/dev');
  mkdirSync(out, { recursive: true });
  const chat = new ChatClient(cacheDir(heldout !== undefined));
  const thinkModel = flag('--think-model') ?? 'anthropic:claude-sonnet-5-5';
  const judgeModel = flag('--judge') ?? 'gpt-6.1-sol';
  const gut = resolveGbrainUnderTest(flag('--gbrain') ?? null);
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void }>(gut, 'src/core/ai/gateway.ts');
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env });
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => any }>(gut, 'src/core/pglite-engine.ts');
  const { importFromContent } = await importGbrain<{ importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<unknown> }>(gut, 'src/core/import-file.ts');
  const { runThink } = await importGbrain<{ runThink: (e: unknown, o: Record<string, unknown>) => Promise<Record<string, any>> }>(gut, 'src/core/think/index.ts');

  const anthropic = new Anthropic();
  let captured = '';
  const client = {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }) => {
      const sys = typeof params.system === 'string' ? params.system : (params.system ?? []).map(b => ('text' in b ? b.text : '')).join('\n');
      captured = [sys, ...params.messages.map(m => typeof m.content === 'string' ? m.content : m.content.map(c => ('text' in c ? c.text : '')).join('\n'))].join('\n\n');
      return anthropic.messages.create({ ...params, model: String(params.model).replace(/^anthropic[:/]/, '') }, opts);
    },
  };
  const rows: Array<Record<string, unknown>> = [];
  const rowsPath = join(out, 'rows.ndjson');
  writeFileSync(rowsPath, '');
  // --replay <rows.ndjson>: the same answers (as the model wrote them) and judge labels, grounded again by this build.
  const replay = flag('--replay') ? new Map(readFileSync(flag('--replay')!, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map((r: any) => [r.id, r])) : null;
  // One brain per corpus, and per haystack for sealed-confirmation: a question sees only the pages of its own corpus.
  const brainOf = (q: Question) => q.corpus === 'amara' ? 'amara' : `sealed-confirmation|${q.haystack}`;
  const groups = new Map<string, Question[]>();
  for (const q of questions) groups.set(brainOf(q), [...(groups.get(brainOf(q)) ?? []), q]);
  for (const [brain, group] of groups) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('think.quote_verify', 'true');
    const brainPages = pages.filter(p => (p.corpus === 'amara' ? 'amara' : `sealed-confirmation|${p.haystack}`) === brain);
    for (const p of brainPages) await importFromContent(engine, p.slug, p.content, {});
    log(`${group[0]!.corpus}: imported ${brainPages.length} pages for ${group.length} question(s)`);
    for (const q of group) {
      captured = '';
      let res: Record<string, any>;
      const prior = replay?.get(q.id) as { answer_raw: string; spans: Array<{ span: string; judge: string }> } | undefined;
      if (replay && !prior) continue;
      try {
        res = await runThink(engine, prior
          ? { question: q.question, remote: false, stubResponse: { answer: prior.answer_raw, citations: [], gaps: [] } }
          : { question: q.question, model: thinkModel, modelExplicit: true, remote: false, client });
      }
      catch (e) { log(`${q.id}: ${(e as Error).message}`); continue; }
      const raw = String(res.answer_raw ?? res.answer ?? '');
      const flaggedTexts = new Set(((res.unverified_quotes ?? []) as Array<{ text: string }>).map(u => u.text.trim()));
      const spans = [];
      for (const span of quoteSpans(raw)) {
        const flagged = [...flaggedTexts].some(t => t.includes(span) || span.includes(t));
        const judged = prior?.spans.find(s => s.span === span)?.judge;
        if (prior && !judged) continue;
        spans.push({ span, gbrain: flagged ? 'flagged' : 'kept', judge: judged ?? await judge(chat, judgeModel, captured, span) });
      }
      const row = { id: q.id, corpus: q.corpus, ...(q.haystack ? { haystack: q.haystack } : {}), kind: q.kind, page: q.page, synthesis_status: res.synthesis_status ?? null, quote_check: res.quote_check ?? null, spans, answer_raw: raw, answer: res.answer };
      rows.push(row);
      writeFileSync(rowsPath, JSON.stringify(row) + '\n', { flag: 'a' });
      log(`${q.id}: ${spans.length} spans, ${spans.filter(s => s.gbrain === 'flagged').length} flagged, judge unsupported ${spans.filter(s => s.judge === 'unsupported').length}`);
    }
    await engine.disconnect();
  }
  const all = rows.flatMap(r => (r.spans as Array<{ gbrain: string; judge: string }>).map(s => ({ ...s, q: r.id as string })));
  const supported = all.filter(s => s.judge !== 'unsupported');
  const unsupported = all.filter(s => s.judge === 'unsupported');
  const wrongFlags = supported.filter(s => s.gbrain === 'flagged');
  const qWithSupported = new Set(supported.map(s => s.q));
  const qWithWrongFlag = new Set(wrongFlags.map(s => s.q));
  const summary = {
    schema: 'p8-quote-grounding-v2', gbrain: gut, think_model: thinkModel, judge_model: judgeModel,
    mode: heldout ? 'custodian' : 'dev', questions_sha256: questionsSha, sealed_corpus_sha256: sealedSha256,
    corpora: Object.fromEntries(CORPORA.map(c => [c, questions.filter(q => q.corpus === c).length])),
    questions: questions.length, answered: rows.length,
    spans: all.length, supported_spans: supported.length, verbatim: all.filter(s => s.judge === 'verbatim').length, close: all.filter(s => s.judge === 'close').length,
    supported_wrongly_flagged: wrongFlags.length, supported_wrongly_flagged_rate: supported.length ? wrongFlags.length / supported.length : null,
    supported_wrongly_flagged_wilson_upper: wilsonUpper(wrongFlags.length, supported.length),
    questions_with_supported: qWithSupported.size, questions_with_a_wrong_flag: qWithWrongFlag.size,
    questions_wrong_flag_wilson_upper: wilsonUpper(qWithWrongFlag.size, qWithSupported.size),
    unsupported_spans: unsupported.length, unsupported_flagged: unsupported.filter(s => s.gbrain === 'flagged').length, unsupported_kept: unsupported.filter(s => s.gbrain === 'kept').length,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) await main();
