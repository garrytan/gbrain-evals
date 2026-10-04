/**
 * P8 quote grounding (dev): does `gbrain think` keep supported quotes and catch
 * unsupported ones?
 *
 * The amara-life-v1 world (rendered as in chronicle-lift) is imported into an
 * in-memory PGLite brain with real embeddings. Each dev question goes through
 * the build's runThink with think.quote_verify on; the runner captures the
 * exact prompt the model saw (runThink's client seam), so the judge sees the
 * delivered evidence, not the whole corpus. Every quoted span in what the model
 * wrote (`answer_raw`, or `answer` when nothing was quoted) is labelled by an
 * independent judge model: verbatim, close (same words with small differences)
 * or unsupported. gbrain's own verdict per span is `flagged` when the span is in
 * `unverified_quotes`, else `kept`.
 *
 * Reported: supported spans wrongly flagged (rate, Wilson 95% upper bound),
 * unsupported spans kept, counts by question. Dev questions only; the sealed
 * question set is the custodian's.
 *
 * Usage:
 *   bun eval/runner/p8-quote-grounding.ts --gbrain <checkout>@<ref> [--questions eval/data/p8-quote-grounding/dev-questions.json]
 *     [--think-model anthropic:claude-sonnet-5-5] [--judge gpt-6.1-sol] --out eval/reports/p8-quote-grounding/<name>
 *   bun eval/runner/p8-quote-grounding.ts --make-questions --n 50 --seed 1 --out-questions <file>
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderCorpus } from './chronicle-lift.ts';
import { importGbrain, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { ChatClient } from './memory-qa/qa.ts';
import { Rng } from '../generators/seeded.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const log = (s: string) => process.stderr.write(`[quotes] ${s}\n`);
const chat = new ChatClient(process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));

interface Question { id: string; page: string; kind: 'quote' | 'natural'; question: string }

async function makeQuestions(n: number, seed: number, out: string, model: string) {
  const pages = renderCorpus().filter(p => /^(meetings|conversations|emails|notes)\//.test(p.path));
  const rng = new Rng(seed);
  const picked = rng.shuffle(pages).slice(0, n);
  const qs: Question[] = [];
  for (const [i, p] of picked.entries()) {
    const kind = i < Math.round(n * 0.7) ? 'quote' : 'natural';
    const ask = kind === 'quote'
      ? 'Write one question a user would ask their memory assistant about this document that is best answered by quoting what someone said or wrote, word for word (for example "What exactly did X say about Y?"). Name the people or topic so the question stands alone without the document.'
      : 'Write one natural question a user would ask their memory assistant that this document answers. Name the people or topic so the question stands alone without the document.';
    const r = await chat.chat(model, `${ask}\nReply with the question only.\n\n<document path="${p.path}">\n${p.content.slice(0, 6000)}\n</document>`, { maxTokens: 300, replicate: 0 });
    qs.push({ id: `q${String(i).padStart(3, '0')}`, page: p.path, kind, question: r.text.trim().replace(/^"|"$/g, '') });
  }
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify({ generator: 'p8-quote-grounding@1', seed, model, questions: qs }, null, 2));
  log(`wrote ${qs.length} questions to ${out}`);
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

async function judge(model: string, evidence: string, span: string): Promise<'verbatim' | 'close' | 'unsupported'> {
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

async function main() {
  if (argv.includes('--make-questions')) return makeQuestions(Number(flag('--n') ?? 50), Number(flag('--seed') ?? 1), flag('--out-questions')!, flag('--model') ?? 'gpt-6.1-sol');
  const out = resolve(flag('--out') ?? 'eval/reports/p8-quote-grounding/dev');
  mkdirSync(out, { recursive: true });
  const questions = (JSON.parse(readFileSync(flag('--questions') ?? 'eval/data/p8-quote-grounding/dev-questions.json', 'utf8')) as { questions: Question[] }).questions;
  const thinkModel = flag('--think-model') ?? 'anthropic:claude-sonnet-5-5';
  const judgeModel = flag('--judge') ?? 'gpt-6.1-sol';
  const gut = resolveGbrainUnderTest(flag('--gbrain') ?? null);
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void }>(gut, 'src/core/ai/gateway.ts');
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env });
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => any }>(gut, 'src/core/pglite-engine.ts');
  const { importFromContent } = await importGbrain<{ importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<unknown> }>(gut, 'src/core/import-file.ts');
  const { runThink } = await importGbrain<{ runThink: (e: unknown, o: Record<string, unknown>) => Promise<Record<string, any>> }>(gut, 'src/core/think/index.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('think.quote_verify', 'true');
  const pages = renderCorpus();
  for (const p of pages) await importFromContent(engine, p.path.replace(/\.md$/, ''), p.content, {});
  log(`imported ${pages.length} pages`);

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
  for (const q of questions) {
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
      spans.push({ span, gbrain: flagged ? 'flagged' : 'kept', judge: judged ?? await judge(judgeModel, captured, span) });
    }
    const row = { id: q.id, kind: q.kind, page: q.page, synthesis_status: res.synthesis_status ?? null, quote_check: res.quote_check ?? null, spans, answer_raw: raw, answer: res.answer };
    rows.push(row);
    writeFileSync(rowsPath, JSON.stringify(row) + '\n', { flag: 'a' });
    log(`${q.id}: ${spans.length} spans, ${spans.filter(s => s.gbrain === 'flagged').length} flagged, judge unsupported ${spans.filter(s => s.judge === 'unsupported').length}`);
  }
  const all = rows.flatMap(r => (r.spans as Array<{ gbrain: string; judge: string }>).map(s => ({ ...s, q: r.id as string })));
  const supported = all.filter(s => s.judge !== 'unsupported');
  const unsupported = all.filter(s => s.judge === 'unsupported');
  const wrongFlags = supported.filter(s => s.gbrain === 'flagged');
  const qWithSupported = new Set(supported.map(s => s.q));
  const qWithWrongFlag = new Set(wrongFlags.map(s => s.q));
  const summary = {
    schema: 'p8-quote-grounding-v1', gbrain: gut, think_model: thinkModel, judge_model: judgeModel, questions: questions.length, answered: rows.length,
    spans: all.length, supported_spans: supported.length, verbatim: all.filter(s => s.judge === 'verbatim').length, close: all.filter(s => s.judge === 'close').length,
    supported_wrongly_flagged: wrongFlags.length, supported_wrongly_flagged_rate: supported.length ? wrongFlags.length / supported.length : null,
    supported_wrongly_flagged_wilson_upper: wilsonUpper(wrongFlags.length, supported.length),
    questions_with_supported: qWithSupported.size, questions_with_a_wrong_flag: qWithWrongFlag.size,
    questions_wrong_flag_wilson_upper: wilsonUpper(qWithWrongFlag.size, qWithSupported.size),
    unsupported_spans: unsupported.length, unsupported_flagged: unsupported.filter(s => s.gbrain === 'flagged').length, unsupported_kept: unsupported.filter(s => s.gbrain === 'kept').length,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await engine.disconnect();
}

await main();
