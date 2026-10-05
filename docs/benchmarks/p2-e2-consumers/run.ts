/**
 * P2 amendment 3: E2 per-consumer date-grounding checks.
 *   bun run.ts fixtures   -> fixtures.json (30 invented dated pages, gemini-3.8-flash)
 *   bun run.ts generate   -> outputs.ndjson (4 prompts x 2 arms x 30 fixtures, product prompt builders)
 *   bun run.ts judge      -> judgments.ndjson (blind pairwise, gpt-6-sol, 10 replicates, random order)
 *   bun run.ts report     -> report.json
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DIR = '/home/user/.capy/work/p2/e2b';
const WT = '/home/user/.capy/work/p2/e2b-wt';
const GEN_MODEL = 'anthropic:claude-sonnet-5-5';
const JUDGE_MODEL = 'gpt-6-sol';
const FIXTURE_MODEL = 'gemini-3.8-flash';
const REPLICATES = 10;
const CONSUMERS = ['chronicle', 'atoms', 'takes', 'synthesis'] as const;
type Consumer = typeof CONSUMERS[number];

interface Fixture { id: string; date: string; title: string; kind: string; body: string }
interface Output { consumer: Consumer; fixture: string; arm: 'current' | 'grounded'; items: string[]; error?: string }

const { unresolvedRelativeTime } = await import('/home/user/.capy/work/p2/evals-p0/eval/runner/memory-qa/qa.ts');

async function gemini(prompt: string, seed: number): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${FIXTURE_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.9, seed } }),
  });
  const j = await res.json() as any;
  if (!res.ok) throw new Error(`gemini ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
}

async function fixtures(): Promise<void> {
  const out: Fixture[] = [];
  for (let batch = 0; batch < 3; batch++) {
    const prompt = `Write 10 short invented pages for a personal knowledge base, as a JSON array of objects {"date","title","kind","body"}.
Rules:
- "date" is the page's own date (YYYY-MM-DD) between 2024-01-01 and 2026-09-30; vary it.
- "kind" is "meeting" (a meeting note), "conversation" (a two-person chat written as "Name: text" lines) or "note" (a journal entry); mix them.
- "body" is 150 to 300 words and contains 3 to 6 RELATIVE time references (examples: yesterday, last week, two days ago, next Tuesday, by Friday, in three weeks, last month, three months ago, earlier this year, tomorrow) and NO absolute dates.
- Each body records at least one decision, one plan or commitment with a deadline, and one prediction or opinion (for example "I think the launch will slip" or "Priya bets revenue doubles by spring").
- Use only invented people, companies and products (no real people or real companies).
Return only the JSON array.`;
    const arr = JSON.parse(await gemini(prompt, 1000 + batch)) as Array<Omit<Fixture, 'id'>>;
    for (const f of arr.slice(0, 10)) out.push({ id: `f${String(out.length + 1).padStart(2, '0')}`, ...f });
  }
  if (out.length !== 30) throw new Error(`expected 30 fixtures, got ${out.length}`);
  writeFileSync(join(DIR, 'fixtures.json'), JSON.stringify({ model: FIXTURE_MODEL, seeds: [1000, 1001, 1002], fixtures: out }, null, 2));
  console.log('fixtures', out.length, createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 16));
}

function stubEngine(grounded: boolean) {
  return { getConfig: async (key: string) => (key === 'extraction.date_grounding' && grounded ? 'true' : null) } as never;
}

async function generate(): Promise<void> {
  const { fixtures: fx } = JSON.parse(readFileSync(join(DIR, 'fixtures.json'), 'utf8')) as { fixtures: Fixture[] };
  const gateway = await import(`${WT}/src/core/ai/gateway.ts`);
  gateway.configureGateway({ chat_model: GEN_MODEL, env: process.env });
  const { defaultJudge } = await import(`${WT}/src/core/chronicle/extract-events.ts`);
  const { atomsPrompt } = await import(`${WT}/src/core/cycle/extract-atoms.ts`);
  const { ATOMS_RESPONSE_SCHEMA } = await import(`${WT}/src/core/cycle/extract-atoms-schema.ts`);
  const { defaultExtractor } = await import(`${WT}/src/core/cycle/propose-takes.ts`);
  const { buildSynthesisPrompt } = await import(`${WT}/src/core/cycle/synthesize.ts`);
  const { ONESHOT_SYSTEM } = await import(`${WT}/src/core/minions/handlers/subagent-oneshot.ts`);
  const outPath = join(DIR, 'outputs.ndjson');
  const done = new Set(existsSync(outPath) ? readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map(l => { const o = JSON.parse(l) as Output; return o.error ? '' : `${o.consumer}|${o.fixture}|${o.arm}`; }) : []);
  const parseJson = (text: string) => { const m = text.match(/[\[{][\s\S]*[\]}]/); return m ? JSON.parse(m[0]) : null; };
  const run = async (c: Consumer, f: Fixture, grounded: boolean): Promise<string[]> => {
    if (c === 'chronicle') {
      const r = await defaultJudge(stubEngine(grounded))({ slug: `meetings/${f.date}-${f.id}`, type: f.kind === 'note' ? 'note' : 'meeting', title: f.title, body: f.body, effectiveDate: f.date, attendees: [] });
      if (r.failure) throw new Error(`chronicle failure ${r.failure}`);
      return r.events.map((e: any) => `${e.when}: ${e.what}`);
    }
    if (c === 'atoms') {
      const res = await gateway.chat({ model: GEN_MODEL, ...atomsPrompt(grounded, `${f.date}-${f.id}.md`, f.body), maxTokens: 6000, responseSchema: ATOMS_RESPONSE_SCHEMA });
      const j = parseJson(res.text);
      return (j?.atoms ?? []).map((a: any) => `${a.title}: ${a.body}`);
    }
    if (c === 'takes') {
      const takes = await defaultExtractor({ pagePath: `notes/${f.date}-${f.id}.md`, pageBody: f.body, existingTakes: [], modelHint: GEN_MODEL, dateGrounding: grounded, observationDate: { date: f.date, source: 'date' } });
      return takes.map((t: any) => t.claim_text);
    }
    const t = { filePath: `/tmp/${f.date}-${f.id}.txt`, contentHash: createHash('sha256').update(f.body).digest('hex'), content: f.body, basename: `${f.date}-${f.id}`, inferredDate: f.date };
    const prompt = buildSynthesisPrompt(t, f.body, 0, 1, '', 'wiki', '', '', [], 'wiki/personal/reflections', 'wiki/originals/ideas', 'oneshot', '2026-10-05', false, grounded);
    const res = await gateway.chat({ model: GEN_MODEL, system: ONESHOT_SYSTEM, messages: [{ role: 'user', content: prompt }], maxTokens: 8000 });
    const j = parseJson(res.text);
    return (j?.pages ?? []).flatMap((p: any) => String(p.content ?? p.body ?? p.compiled_truth ?? '').split(/\n+/).map((s: string) => s.trim()).filter((s: string) => s && !s.startsWith('---') && !/^[a-z_]+:\s/.test(s)));
  };
  const jobs: Array<[Consumer, Fixture, boolean]> = [];
  for (const c of CONSUMERS) for (const f of fx) for (const g of [false, true]) if (!done.has(`${c}|${f.id}|${g ? 'grounded' : 'current'}`)) jobs.push([c, f, g]);
  console.log('jobs', jobs.length);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [c, f, g] = jobs[i++];
      const o: Output = { consumer: c, fixture: f.id, arm: g ? 'grounded' : 'current', items: [] };
      try { o.items = await run(c, f, g); } catch (e) { o.error = (e as Error).message.slice(0, 300); }
      appendFileSync(outPath, JSON.stringify(o) + '\n');
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

async function openai(prompt: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'user', content: prompt }], max_completion_tokens: 2000 }),
    });
    const j = await res.json() as any;
    if (res.ok) return String(j.choices?.[0]?.message?.content ?? '');
    if (res.status < 500 && res.status !== 429) throw new Error(`openai ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new Error('openai retries exhausted');
}

async function judge(): Promise<void> {
  const { fixtures: fx } = JSON.parse(readFileSync(join(DIR, 'fixtures.json'), 'utf8')) as { fixtures: Fixture[] };
  const outs = readFileSync(join(DIR, 'outputs.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Output).filter(o => !o.error);
  const get = (c: string, f: string, a: string) => outs.filter(o => o.consumer === c && o.fixture === f && o.arm === a).at(-1);
  const path = join(DIR, 'judgments.ndjson');
  const done = new Set(existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => { const j = JSON.parse(l); return `${j.consumer}|${j.fixture}|${j.rep}`; }) : []);
  const jobs: Array<{ c: Consumer; f: Fixture; rep: number; cur: Output; grd: Output }> = [];
  for (const c of CONSUMERS) for (const f of fx) {
    const cur = get(c, f.id, 'current'); const grd = get(c, f.id, 'grounded');
    if (!cur || !grd) continue;
    for (let rep = 0; rep < REPLICATES; rep++) if (!done.has(`${c}|${f.id}|${rep}`)) jobs.push({ c, f, rep, cur, grd });
  }
  console.log('judge jobs', jobs.length);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const { c, f, rep, cur, grd } = jobs[i++];
      const groundedFirst = createHash('sha256').update(`${c}|${f.id}|${rep}`).digest()[0] % 2 === 0;
      const [a, b] = groundedFirst ? [grd, cur] : [cur, grd];
      const fmt = (o: Output) => o.items.length ? o.items.map(s => `- ${s}`).join('\n') : '(nothing extracted)';
      const prompt = `A personal memory system read the source page below (written on ${f.date}) and stored the items in output A or output B. Which output records the source more accurately and usefully as long-term memory, so that someone reading it months later understands it correctly? Dates count: a stored item should mean the same thing later as it did on ${f.date}. Do not prefer an output just because it is longer.

SOURCE (written ${f.date}):
${f.title}
${f.body}

OUTPUT A:
${fmt(a)}

OUTPUT B:
${fmt(b)}

Answer with exactly one word on the last line: A, B or TIE.`;
      let verdict = 'error';
      try {
        const text = await openai(prompt);
        const last = text.trim().split('\n').pop()!.trim().toUpperCase().replace(/[^A-Z]/g, '');
        verdict = last === 'TIE' ? 'tie' : last === 'A' ? (groundedFirst ? 'grounded' : 'current') : last === 'B' ? (groundedFirst ? 'current' : 'grounded') : 'unparsed';
      } catch (e) { verdict = `error:${(e as Error).message.slice(0, 120)}`; }
      appendFileSync(path, JSON.stringify({ consumer: c, fixture: f.id, rep, groundedFirst, verdict }) + '\n');
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

function report(): void {
  const outs = readFileSync(join(DIR, 'outputs.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Output);
  const judg = readFileSync(join(DIR, 'judgments.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const result: Record<string, unknown> = {};
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const c of CONSUMERS) {
    const last = (f: string, a: string) => outs.filter(o => o.consumer === c && o.fixture === f && o.arm === a && !o.error).at(-1);
    const fixturesSeen = [...new Set(outs.filter(o => o.consumer === c).map(o => o.fixture))].sort();
    const unresolved = { current: 0, grounded: 0, items_current: 0, items_grounded: 0 };
    for (const f of fixturesSeen) for (const a of ['current', 'grounded'] as const) {
      const o = last(f, a); if (!o) continue;
      unresolved[a] += o.items.filter(s => unresolvedRelativeTime(s)).length;
      unresolved[a === 'current' ? 'items_current' : 'items_grounded'] += o.items.length;
    }
    const perFixture = fixturesSeen.map(f => {
      const js = judg.filter(j => j.consumer === c && j.fixture === f && ['grounded', 'current', 'tie'].includes(j.verdict));
      return js.length ? js.reduce((s, j) => s + (j.verdict === 'grounded' ? 1 : j.verdict === 'tie' ? 0.5 : 0), 0) / js.length : null;
    }).filter((x): x is number => x !== null);
    const mean = perFixture.reduce((a, b) => a + b, 0) / perFixture.length;
    const boots: number[] = [];
    for (let k = 0; k < 10000; k++) { let s = 0; for (let n = 0; n < perFixture.length; n++) s += perFixture[Math.floor(rand() * perFixture.length)]; boots.push(s / perFixture.length); }
    boots.sort((a, b) => a - b);
    const lower = boots[249]; const upper = boots[9749];
    const errors = outs.filter(o => o.consumer === c && o.error).length;
    const verdictCounts = judg.filter(j => j.consumer === c).reduce((m: Record<string, number>, j) => { m[j.verdict.startsWith('error') ? 'error' : j.verdict] = (m[j.verdict.startsWith('error') ? 'error' : j.verdict] ?? 0) + 1; return m; }, {});
    result[c] = { fixtures_scored: perFixture.length, unresolved, judge_score: mean, judge_ci95: [lower, upper], verdict_counts: verdictCounts, generation_errors: errors,
      pass_a: unresolved.grounded < unresolved.current, pass_b: lower >= 0.45, pass: unresolved.grounded < unresolved.current && lower >= 0.45 };
  }
  writeFileSync(join(DIR, 'report.json'), JSON.stringify({ generation_model: GEN_MODEL, judge_model: JUDGE_MODEL, replicates: REPLICATES, result }, null, 2));
  console.log(JSON.stringify(result, null, 1));
}

const cmd = process.argv[2];
if (cmd === 'fixtures') await fixtures();
else if (cmd === 'generate') await generate();
else if (cmd === 'judge') await judge();
else if (cmd === 'report') report();
else throw new Error('usage: run.ts fixtures|generate|judge|report');
