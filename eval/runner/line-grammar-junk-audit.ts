/**
 * P5 H3: does the typed line grammar stay out of ordinary list lines?
 *
 * gbrain's line grammar reads two list-item shapes as structure:
 *   relation line   `- works_at [[companies/acme]]`: one type word, then exactly one link
 *   fact line       `- [preference] Prefers oat milk`: a bracketed category, then a claim
 * Everything else stays text. This audit runs the build's grammar, through the real write
 * path, over list lines its guards were never tuned on, and counts what it mints:
 *   lme-s       LongMemEval-S haystack sessions rendered as markdown pages (memory-qa renderSessionPage),
 *               one page per distinct session id
 *   locomo      LoCoMo transcripts, one page per session
 *   blue-book   a public notes vault (github.com/lyz-code/blue-book, CC0-1.0, pinned commit and per-file
 *               git blob hashes in eval/decisions/datasets/blue-book-e494de6.json; text is downloaded, never committed)
 *
 * Minting pass (hermetic, $0): every page with at least one list line is written with put_page on an
 * in-memory brain of the build under test with line_grammar.enabled=true (plus GBRAIN_EVAL_CONFIG). The
 * write's `line_grammar` advisory gives the counts; the build's own parseLineGrammar over the stored page
 * text, with the active schema pack's link verbs as put_page uses them, names the lines, and the two must
 * agree or the page is a harness error. A list line is a line matching the grammar's list-item shape
 * (`-`, `*`, `+` or `1.`/`1)` then a space) outside fenced code and frontmatter, counted by this runner.
 *
 * Zero-tolerance checks (deterministic, independent of the build's guards) run on every minted line: a
 * minted line whose item starts with a timecode, a task marker, a citation or a date, or that sits in a
 * machine-written section (Timeline, See also, Related, Facts, Sources, Links, Email mention links,
 * Backlinks, Significant moments, or after `<!-- timeline -->`), is a violation.
 *
 * Precision (paid): a seeded sample of list lines (`--frame list`, the preregistered frame) or of minted
 * lines (`--frame minted`); each minted line in the sample is labeled by two judge models
 * (claude-sonnet-5-5 and gpt-6.1-sol by default), asked whether the author meant the line to state the typed
 * relation or fact the parser read. precision = minted lines both judges call correct / minted lines in the
 * sample; a line the judges disagree on counts as wrong. There is no adjudication queue, so line text and context
 * never land in an output directory.
 *
 * Held-out text: documents are split once, by document, into a dev part and a held-out part. LoCoMo uses
 * its committed conversation split (eval/decisions/splits/locomo.json: dev vs sealed conversations); LongMemEval-S
 * sessions and vault files go to dev when sha256("p5-h3-partition-v1", NUL, corpus, NUL, id) falls in its first
 * tenth. Dev runs read only the dev part and draw samples with dev seeds 1-3. The custodian's run reads the
 * held-out part: --phrasing-file <custody path> --decision-id <id> --purpose <text> with
 * `{ "id": ..., "templates": { "sample_seed": n, "sample_size": 300, "frame": "list" } }` and explicit --output and
 * --work outside every git worktree; rows then omit line text, and docs.jsonl and labels.jsonl (line text and
 * context) live under --work.
 *
 * Usage:
 *   bun eval/runner/line-grammar-junk-audit.ts fetch-vault                       download and verify the vault
 *   bun eval/runner/line-grammar-junk-audit.ts --gbrain <checkout>@<ref> --output <dir> [--corpora lme-s,locomo,blue-book]
 *     [--sample-seed 1] [--sample-size 300] [--frame list|minted] [--judges claude-sonnet-5-5,gpt-6.1-sol]
 *     [--pilot | --limit N] [--no-judge] [--work <dir>] [--paid --budget-usd N | --paid --budget-run-id <id>]
 * Resumable: <work>/docs.jsonl holds one line per written page and <work>/labels.jsonl one per (line, judge); --work
 * defaults to --output in dev runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { DATASET_ROOT, loadLmeS, loadLocomo, renderSessionPage, type Corpus } from './memory-qa/corpus.ts';
import { loadSplit } from './decisions/splits.ts';
import { custodyInput, openP5Brain, p5Receipt } from './p5-brain.ts';
import { Checkpoint, chatText, closePaid, firstJsonObject, flagValue, limitFlag, openPaid, runPool, seededSample, selectUnits, type PaidSession } from './p5-agent.ts';
import { receiptCost, type RunSummary } from './budget-ledger.ts';
import { writeReceipt } from './receipt.ts';

export const CATEGORY = 'line-grammar-junk-audit';
export const DEV_SEEDS: readonly number[] = [1, 2, 3];
export const CORPORA = ['lme-s', 'locomo', 'blue-book'] as const;
export type CorpusId = typeof CORPORA[number];
export const DEFAULT_JUDGES = ['claude-sonnet-5-5', 'gpt-6.1-sol'];
export const PARTITION_SALT = 'p5-h3-partition-v1';
export const JUDGE_PROMPT_VERSION = 'p5-h3-judge-v1';
const REPO = resolve(import.meta.dir, '../..');
const VAULT_MANIFEST = join(REPO, 'eval/decisions/datasets/blue-book-e494de6.json');

// ─── Documents and the dev / held-out split ─────────────────────────

export interface AuditDoc { id: string; corpus: CorpusId; slug: string; content: string }

/** Dev part for hash-split corpora: the first tenth of sha256(salt, corpus, id). */
export function inDevPart(corpus: CorpusId, id: string): boolean {
  const h = createHash('sha256').update(`${PARTITION_SALT}\u0000${corpus}\u0000${id}`).digest('hex');
  return parseInt(h.slice(0, 8), 16) / 2 ** 32 < 0.1;
}

const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'x';

interface VaultManifest { commit: string; license: string; source: string; raw_base: string; files: Array<{ path: string; git_blob_sha1: string; bytes: number }> }
export const vaultManifest = (): VaultManifest => JSON.parse(readFileSync(VAULT_MANIFEST, 'utf8'));
const blobSha1 = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const vaultPath = (p: string) => join(DATASET_ROOT, 'blue-book', p);

export async function fetchVault(log: (s: string) => void): Promise<{ fetched: number; verified: number }> {
  const m = vaultManifest();
  let fetched = 0; let verified = 0;
  await runPool(m.files, 16, async f => {
    const path = vaultPath(f.path);
    if (existsSync(path) && blobSha1(readFileSync(path)) === f.git_blob_sha1) { verified++; return; }
    const res = await fetch(m.raw_base + f.path.split('/').map(encodeURIComponent).join('/'));
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${f.path}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (blobSha1(bytes) !== f.git_blob_sha1) throw new Error(`${f.path}: blob hash mismatch with the pinned manifest`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    fetched++; verified++;
  });
  log(`blue-book: ${verified} files verified (${fetched} downloaded) under ${join(DATASET_ROOT, 'blue-book')}`);
  return { fetched, verified };
}

/** Documents of one corpus in the requested part. Held-out text is only read in custodian mode. */
export function loadDocs(corpus: CorpusId, part: 'dev' | 'held-out'): AuditDoc[] {
  if (corpus === 'blue-book') {
    const out: AuditDoc[] = [];
    for (const f of vaultManifest().files) {
      if (inDevPart(corpus, f.path) !== (part === 'dev')) continue;
      const path = vaultPath(f.path);
      if (!existsSync(path)) throw new Error(`blue-book: ${f.path} is not downloaded; run \`bun eval/runner/line-grammar-junk-audit.ts fetch-vault\``);
      const bytes = readFileSync(path);
      if (blobSha1(bytes) !== f.git_blob_sha1) throw new Error(`blue-book: ${f.path} is not the pinned bytes; rerun fetch-vault`);
      out.push({ id: f.path, corpus, slug: `notes/${slugPart(f.path.replace(/\.md$/, ''))}`, content: bytes.toString('utf8') });
    }
    return out;
  }
  const c: Corpus = corpus === 'lme-s' ? loadLmeS() : loadLocomo();
  const split = corpus === 'locomo' ? loadSplit('locomo') : null;
  const seen = new Set<string>();
  const out: AuditDoc[] = [];
  for (const conv of c.conversations) {
    if (split && split.dev.includes(conv.id) !== (part === 'dev')) continue;
    for (const s of conv.sessions) {
      const id = corpus === 'lme-s' ? s.id : `${conv.id}:${s.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!split && inDevPart(corpus, id) !== (part === 'dev')) continue;
      out.push({ id, corpus, slug: `chat/${createHash('sha256').update(`${corpus}\u0000${id}`).digest('hex').slice(0, 16)}`, content: renderSessionPage(s) });
    }
  }
  return out;
}

// ─── List lines and zero-tolerance classes ──────────────────────────

const LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
const MACHINE_HEADING_RE = /^(#{1,6})[ \t]+(?:timeline|see[ -]also|related|facts|sources|links|email mention links|backlinks|significant moments)\b/i;
const ANY_HEADING_RE = /^(#{1,6})[ \t]/;

export type ZeroToleranceClass = 'timecode' | 'task_marker' | 'citation' | 'date' | 'machine_section';
export interface ListLine { line: number; text: string; content: string; zero_tolerance: ZeroToleranceClass | null }

/** Shape class of a list item's content that must never mint (null when it is ordinary). */
export function itemClass(content: string): Exclude<ZeroToleranceClass, 'machine_section'> | null {
  const c = content.trim();
  if (/^[[(]?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?[\])]?(?:\s|$|[-–—:])/.test(c) || /^[[(]?\d{1,2}:\d{2}:\d{2}/.test(c)) return 'timecode';
  if (/^\[[ xX]\]/.test(c) || /^\[(?:todo|done|wip|x)\]/i.test(c) || /^(?:TODO|DONE|FIXME|WIP)\b/.test(c)) return 'task_marker';
  if (/^\[\^[^\]]*\]/.test(c) || /^\[\d+\]/.test(c) || /^\[(?:source|sources|cite|ref|citation)\b/i.test(c) || /^\[@/.test(c)) return 'citation';
  if (/^[[(]?\d{4}-\d{2}(?:-\d{2})?\b/.test(c) || /^[[(]?\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(c)
    || /^[[(]?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(c)) return 'date';
  return null;
}

/** Every list line of a page body (outside frontmatter and fenced code), with its zero-tolerance class. */
export function listLines(text: string): ListLine[] {
  const lines = text.split('\n');
  const out: ListLine[] = [];
  let i = 0;
  if (lines[0]?.trim() === '---') { const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---'); if (end > 0) i = end + 1; }
  let fence = false;
  let machine: number | null = null;
  let afterTimeline = false;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (FENCE_RE.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (/<!--\s*timeline\s*-->/i.test(line)) afterTimeline = true;
    const heading = ANY_HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (machine !== null && level <= machine) machine = null;
      if (MACHINE_HEADING_RE.test(line)) machine = level;
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (!item) continue;
    out.push({ line: i + 1, text: line, content: item[2], zero_tolerance: machine !== null || afterTimeline ? 'machine_section' : itemClass(item[2]) });
  }
  return out;
}

// ─── Minting pass ───────────────────────────────────────────────────

export interface MintedLine { id: string; doc: string; corpus: string; line: number; kind: 'relation' | 'fact'; parsed: string; text: string; context: string; zero_tolerance: string | null }
export interface DocRecord {
  key: string; corpus: string; doc: string; list_lines: number; zero_tolerance_list_lines: Record<string, number>;
  advisory: { relations: number; facts: number } | null; minted: MintedLine[]; error?: string;
}

export const CONTROL_PAGE = '---\ntype: note\ntitle: "H3 control"\n---\n\n- works_at [[companies/acme-example]]\n- [preference] Prefers tea\n- Met [[people/alice-example]] for lunch today\n';

interface Grammar {
  parseLineGrammar(text: string, o: { declaredTypes?: ReadonlySet<string> | null }): {
    facts: Array<{ line: number; category: string; claim: string }>; relations: Array<{ line: number; type: string }>;
  };
}

/** A page to write in the minting pass. */
export interface MintDoc { id: string; corpus: string; slug: string; content: string }

/**
 * The minting pass: every page with a list line is written with put_page on one in-memory brain (positive control
 * first), its minted lines named by the build's parseLineGrammar and cross-checked with the advisory, then deleted.
 * `classify` gives each list line's zero-tolerance class (default: this runner's five classes).
 */
export async function mintDocs(gut: GbrainUnderTest, docs: readonly MintDoc[], config: Record<string, string>, checkpoint: Checkpoint<DocRecord>, log: (s: string) => void,
  classify: (text: string) => Array<{ line: number; zero_tolerance: string | null }> = listLines, itemClassOf: (content: string) => string | null = itemClass): Promise<Record<string, unknown>> {
  if (!existsSync(join(gut.root, 'src/core/line-grammar.ts'))) throw new Error(`gbrain ${gut.version} has no line grammar (src/core/line-grammar.ts); H3 audits the candidate build`);
  return withHermeticEnv(CATEGORY, async () => {
    const grammar = await importGbrain<Grammar>(gut, 'src/core/line-grammar.ts');
    const { loadActivePackForLocalEngine } = await importGbrain<{ loadActivePackForLocalEngine: (e: unknown, o: { sourceId: string }) => Promise<{ manifest?: { link_types: Array<{ name: string }> } } | null> }>(gut, 'src/core/schema-pack/best-effort.ts');
    const brain = await openP5Brain(gut, config);
    try {
      const pack = (await loadActivePackForLocalEngine(brain.engine, { sourceId: 'default' }))?.manifest ?? null;
      const declaredTypes = config['line_grammar.allow_undeclared_types'] === 'true' ? null : pack?.link_types.length ? new Set(pack.link_types.map(l => l.name)) : null;
      // Positive control: a page with one relation line, one fact line and one prose decoy must mint exactly two lines,
      // or a zero count below would mean a broken pass, not a clean grammar.
      const control = await brain.put('notes/p5-h3-control', CONTROL_PAGE);
      const advisory = control.line_grammar as { relations?: number; facts?: number } | undefined;
      if (advisory?.relations !== 1 || advisory?.facts !== 1) throw new Error(`positive control failed: put_page reported ${JSON.stringify(advisory ?? null)} for one relation line and one fact line`);
      const controlSnap = await brain.engine.readPageSnapshot('notes/p5-h3-control', { sourceId: 'default' });
      await brain.op('delete_page', { slug: 'notes/p5-h3-control', ...(controlSnap ? { expected_revision: controlSnap.revision } : {}) });
      let n = 0;
      for (const doc of docs) {
        const key = `${doc.corpus}|${doc.id}`;
        if (checkpoint.has(key)) continue;
        const list = classify(doc.content);
        const ztList: Record<string, number> = {};
        for (const l of list) if (l.zero_tolerance) ztList[l.zero_tolerance] = (ztList[l.zero_tolerance] ?? 0) + 1;
        const record: DocRecord = { key, corpus: doc.corpus, doc: doc.id, list_lines: list.length, zero_tolerance_list_lines: ztList, advisory: null, minted: [] };
        if (list.length) {
          try {
            const outcome = await brain.put(doc.slug, doc.content);
            const adv = outcome.line_grammar as { relations?: number; facts?: number } | undefined;
            record.advisory = { relations: adv?.relations ?? 0, facts: adv?.facts ?? 0 };
            const [stored] = await brain.engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug = $1 AND deleted_at IS NULL', [doc.slug]);
            const body = stored?.compiled_truth ?? '';
            const parsed = grammar.parseLineGrammar(body, { declaredTypes });
            if (parsed.relations.length !== record.advisory.relations || parsed.facts.length !== record.advisory.facts) {
              throw new Error(`put_page reported ${record.advisory.relations} relation(s) and ${record.advisory.facts} fact(s); parseLineGrammar over the stored text found ${parsed.relations.length} and ${parsed.facts.length}`);
            }
            const bodyLines = body.split('\n');
            const classes = new Map(classify(body).map(l => [l.line, l.zero_tolerance]));
            const mint = (line: number, kind: MintedLine['kind'], parsedAs: string) => record.minted.push({
              id: `${doc.corpus}:${doc.id}:${line}`, doc: doc.id, corpus: doc.corpus, line, kind, parsed: parsedAs, text: bodyLines[line - 1] ?? '',
              context: bodyLines.slice(Math.max(0, line - 4), line + 3).join('\n'), zero_tolerance: classes.get(line) ?? itemClassOf((bodyLines[line - 1] ?? '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')),
            });
            for (const r of parsed.relations) mint(r.line, 'relation', `relation type ${r.type}`);
            for (const f of parsed.facts) mint(f.line, 'fact', `fact category ${f.category}`);
            const snap = await brain.engine.readPageSnapshot(doc.slug, { sourceId: 'default' });
            await brain.op('delete_page', { slug: doc.slug, ...(snap ? { expected_revision: snap.revision } : {}) });
          } catch (e) { record.error = (e as Error).message; }
        }
        checkpoint.append(record);
        if (++n % 500 === 0) log(`minting pass: ${n} pages written`);
      }
      return { ...brain.configRecord, positive_control: 'passed: 1 relation line and 1 fact line minted, prose decoy not minted' };
    } finally { await brain.close(); }
  });
}

// ─── Judges ─────────────────────────────────────────────────────────

export const JUDGE_SYSTEM = 'You audit a markdown parser for a personal knowledge base. You answer with one JSON object and nothing else.';

export function judgePrompt(m: Pick<MintedLine, 'kind' | 'parsed' | 'text' | 'context'>): string {
  const what = m.kind === 'relation'
    ? 'a typed relation line: the parser stores the link on this line as a relationship of the type named by the word(s) before the link'
    : 'a typed fact line: the parser records the text after the bracketed word as a fact of that category';
  return [
    `The parser read the list line below as ${what}. It read it as: ${m.parsed}.`,
    '',
    `Line:\n${m.text}`,
    '',
    `Surrounding lines (for context):\n${m.context}`,
    '',
    'Question: did the author of this line really intend it to state that typed relation or fact? Answer "correct" only if a careful reader would agree the line deliberately states a relationship of that type (relation line) or a fact under that category label (fact line). Answer "incorrect" if the bracket or leading word is something else (a timestamp, a checkbox, a citation, a date, a label for a list of links, a heading-like word, part of a sentence, a speaker name), or the line is not about a relationship or fact at all.',
    'Reply with JSON: {"verdict": "correct" | "incorrect", "reason": "<one sentence>"}',
  ].join('\n');
}

interface LabelRecord { key: string; id: string; judge: string; verdict: 'correct' | 'incorrect' | null; reason: string; usd: number; error?: string }

// ─── Summary ────────────────────────────────────────────────────────

export function summarizeH3(docs: readonly DocRecord[], sampleIds: ReadonlySet<string>, sampledListLines: number, labels: ReadonlyMap<string, Record<string, LabelRecord>>, judges: readonly string[]): Record<string, unknown> {
  const per = (corpus: string | null) => {
    const ds = docs.filter(d => corpus === null || d.corpus === corpus);
    const list = ds.reduce((a, d) => a + d.list_lines, 0);
    const minted = ds.flatMap(d => d.minted);
    const rel = minted.filter(m => m.kind === 'relation').length;
    const facts = minted.filter(m => m.kind === 'fact').length;
    return { pages: ds.length, pages_with_list_lines: ds.filter(d => d.list_lines > 0).length, list_lines: list, minted: minted.length, minted_relations: rel, minted_facts: facts,
      minted_per_1000_list_lines: list ? 1000 * minted.length / list : null, relations_per_1000: list ? 1000 * rel / list : null, facts_per_1000: list ? 1000 * facts / list : null,
      zero_tolerance_violations: minted.filter(m => m.zero_tolerance).length, errors: ds.filter(d => d.error).length };
  };
  const minted = docs.flatMap(d => d.minted);
  const violations = minted.filter(m => m.zero_tolerance);
  const sampled = minted.filter(m => sampleIds.has(m.id));
  let agreedCorrect = 0, agreedIncorrect = 0, disagree = 0, unlabeled = 0;
  for (const m of sampled) {
    const ls = labels.get(m.id) ?? {};
    const verdicts = judges.map(j => ls[j]?.verdict ?? null);
    if (verdicts.some(v => v === null)) { unlabeled++; continue; }
    if (verdicts.every(v => v === 'correct')) agreedCorrect++;
    else if (verdicts.every(v => v === 'incorrect')) agreedIncorrect++;
    else disagree++;
  }
  const n = sampled.length;
  return {
    ...per(null),
    per_corpus: Object.fromEntries([...new Set([...CORPORA, ...docs.map(d => d.corpus)])].map(c => [c, per(c)])),
    zero_tolerance: {
      violations: violations.length,
      by_class: violations.reduce((a, m) => ({ ...a, [m.zero_tolerance!]: (a[m.zero_tolerance!] ?? 0) + 1 }), {} as Record<string, number>),
      list_lines_by_class: docs.reduce((a, d) => { for (const [k, v] of Object.entries(d.zero_tolerance_list_lines)) a[k] = (a[k] ?? 0) + v; return a; }, {} as Record<string, number>),
    },
    precision: {
      sampled_list_lines: sampledListLines, minted_in_sample: n, labeled: n - unlabeled, agreed_correct: agreedCorrect, agreed_incorrect: agreedIncorrect,
      disagreements: disagree,
      // A disagreement counts as wrong: there is no adjudication, so line text never leaves the judges.
      precision_agreed_correct: n && !unlabeled ? agreedCorrect / n : null,
    },
  };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const log = (s: string) => process.stderr.write(`[h3] ${s}\n`);
  if (argv[0] === 'fetch-vault') { await fetchVault(log); return; }
  const sampleSeedFlag = Number(flagValue(argv, '--sample-seed') ?? 1);
  const custody = custodyInput(argv, [sampleSeedFlag], DEV_SEEDS, { needsWork: true });
  const sealed = custody ? custody.parsed.templates as { sample_seed: number; sample_size: number; frame?: 'list' | 'minted' } : null;
  if (sealed && (!Number.isInteger(sealed.sample_seed) || !Number.isInteger(sealed.sample_size))) throw new Error('custody file templates need integer sample_seed and sample_size');
  if (sealed && DEV_SEEDS.includes(sealed.sample_seed)) throw new Error(`the held-out sample seed must not be a dev seed (${DEV_SEEDS.join(', ')})`);
  const part = sealed ? 'held-out' : 'dev';
  const sampleSeed = sealed?.sample_seed ?? sampleSeedFlag;
  const sampleSize = sealed?.sample_size ?? Number(flagValue(argv, '--sample-size') ?? 300);
  const frame = (sealed?.frame ?? flagValue(argv, '--frame') ?? 'list') as 'list' | 'minted';
  if (!['list', 'minted'].includes(frame)) throw new Error('--frame must be list or minted');
  const corpora = (flagValue(argv, '--corpora') ?? CORPORA.join(',')).split(',') as CorpusId[];
  for (const c of corpora) if (!CORPORA.includes(c)) throw new Error(`unknown corpus ${c}`);
  const judges = (flagValue(argv, '--judges') ?? DEFAULT_JUDGES.join(',')).split(',');
  const noJudge = argv.includes('--no-judge');
  const config = { ...parseEvalConfig(), 'line_grammar.enabled': 'true' };
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const output = resolve(custody?.roots.output ?? flagValue(argv, '--output') ?? join(REPO, 'eval/reports', CATEGORY));
  const work = resolve(custody?.roots.work ?? flagValue(argv, '--work') ?? output);
  mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString();

  if (corpora.includes('blue-book')) await fetchVault(log);
  const allDocs = corpora.flatMap(c => loadDocs(c, part));
  const docs = selectUnits(allDocs, d => `${d.corpus}|${d.id}`, { pilot: argv.includes('--pilot'), limit: limitFlag(argv) });
  log(`gbrain ${gut.version}${gut.overlay ? ` ${gut.overlay.build.commit.slice(0, 12)}` : ''}; ${part} part: ${allDocs.length} pages, running ${docs.length}`);
  const docCheckpoint = new Checkpoint<DocRecord>(join(work, 'docs.jsonl'));
  let harnessError: string | null = null;
  let configRecord: Record<string, unknown> | null = null;
  try { configRecord = await mintDocs(gut, docs, config, docCheckpoint, log); }
  catch (e) { harnessError = (e as Error).message; }
  const keys = new Set(docs.map(d => `${d.corpus}|${d.id}`));
  const records = docCheckpoint.values().filter(r => keys.has(r.key));
  const minted = records.flatMap(r => r.minted);

  // Sample: list frame draws list lines (every list line has an id), minted frame draws minted lines.
  const listIds = records.flatMap(r => Array.from({ length: r.list_lines }, (_, i) => `${r.corpus}:${r.doc}:#${i}`));
  const mintedIds = minted.map(m => m.id);
  let sampleIds: Set<string>;
  let sampledListLines: number;
  if (frame === 'minted') { sampleIds = new Set(seededSample(mintedIds, sampleSize, sampleSeed)); sampledListLines = sampleIds.size; }
  else {
    // List lines are indexed per page in reading order; a sampled index maps to a minted line when that line minted.
    const drawn = seededSample(listIds, sampleSize, sampleSeed);
    sampledListLines = drawn.length;
    sampleIds = new Set<string>();
    const byDoc = new Map(records.map(r => [`${r.corpus}:${r.doc}`, r]));
    for (const d of drawn) {
      const at = d.lastIndexOf(':#');
      const r = byDoc.get(d.slice(0, at))!;
      const doc = docs.find(x => x.corpus === r.corpus && x.id === r.doc)!;
      const line = listLines(doc.content)[Number(d.slice(at + 2))];
      const hit = r.minted.find(m => m.text.trim() === line?.text.trim());
      if (hit) sampleIds.add(hit.id);
    }
  }
  const toJudge = minted.filter(m => sampleIds.has(m.id));
  const labelCheckpoint = new Checkpoint<LabelRecord>(join(work, 'labels.jsonl'));
  const pending = noJudge ? [] : toJudge.flatMap(m => judges.map(j => ({ m, j }))).filter(x => !labelCheckpoint.has(`${x.m.id}|${x.j}`) || labelCheckpoint.done.get(`${x.m.id}|${x.j}`)!.verdict === null);
  let paid: PaidSession | null = null;
  let summary: RunSummary | null = null;
  if (!harnessError && pending.length) {
    try {
      paid = openPaid(argv, CATEGORY, Number(flagValue(argv, '--estimate-usd') ?? Math.max(0.5, pending.length * 0.01).toFixed(2)), join(output, 'budget-run.json'), log);
      await runPool(pending, 6, async ({ m, j }) => {
        let rec: LabelRecord;
        try {
          const r = await chatText(j, JUDGE_SYSTEM, judgePrompt(m), { maxTokens: 2000 });
          const v = String(firstJsonObject(r.text)?.verdict ?? '').toLowerCase();
          rec = { key: `${m.id}|${j}`, id: m.id, judge: j, verdict: v === 'correct' || v === 'incorrect' ? v : null, reason: String(firstJsonObject(r.text)?.reason ?? r.text.slice(0, 300)), usd: r.usd,
            ...(v === 'correct' || v === 'incorrect' ? {} : { error: 'unparseable verdict' }) };
        } catch (e) {
          if ((e as Error).name === 'BudgetExceededError') throw e;
          rec = { key: `${m.id}|${j}`, id: m.id, judge: j, verdict: null, reason: '', usd: 0, error: (e as Error).message };
        }
        labelCheckpoint.append(rec);
      });
    } catch (e) { harnessError = (e as Error).message; }
    finally { if (paid) summary = closePaid(paid, !harnessError); }
  }
  const labels = new Map<string, Record<string, LabelRecord>>();
  for (const l of labelCheckpoint.values()) (labels.get(l.id) ?? labels.set(l.id, {}).get(l.id)!)[l.judge] = l;
  const redact = !!sealed;
  const rows = minted.map(m => {
    const ls = labels.get(m.id) ?? {};
    const verdicts = judges.map(j => ls[j]?.verdict ?? null);
    const sampledRow = sampleIds.has(m.id);
    return {
      id: m.id, cluster: `${m.corpus}:${m.doc}`, corpus: m.corpus, kind: m.kind, zero_tolerance_class: m.zero_tolerance, violation: Number(!!m.zero_tolerance),
      sampled: Number(sampledRow), ...(redact ? {} : { line: m.text, parsed: m.parsed }),
      ...(sampledRow ? { labels: Object.fromEntries(judges.map((j, i) => [j, verdicts[i]])),
        ...(verdicts.every(v => v) ? { agreed_correct: Number(verdicts.every(v => v === 'correct')), judges_disagree: Number(new Set(verdicts).size > 1) } : {}) } : {}),
    };
  });
  const docErrors = records.filter(r => r.error);
  const sum = summarizeH3(records, sampleIds, sampledListLines, labels, judges);
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, rows, harnessError: harnessError ?? (docErrors.length ? `${docErrors.length} page(s) failed the write or the count cross-check; first: ${docErrors[0].error}` : null),
    summary: { ...sum, judge_usd: [...labels.values()].flatMap(x => Object.values(x)).reduce((a, l) => a + l.usd, 0), label_errors: labelCheckpoint.values().filter(l => l.error).length },
    basis: summary ? 'judge calls through the paid-request guard; the minting pass is hermetic' : 'hermetic minting pass; no judge call in this invocation',
    resolvedConfig: {
      part, corpora, pages: docs.length, pages_in_part: allDocs.length, pilot: argv.includes('--pilot'), limit: limitFlag(argv),
      sample: { frame, seed: sealed ? 'held-out (custody file)' : sampleSeed, size: sampleSize }, judges: noJudge ? [] : judges, judge_prompt: JUDGE_PROMPT_VERSION,
      partition: `${PARTITION_SALT}: locomo by eval/decisions/splits/locomo.json conversations; lme-s sessions and blue-book files by sha256 first tenth`,
      datasets: { 'lme-s': 'LongMemEval-S cleaned 98d7416c (MIT)', locomo: 'LoCoMo locomo10.json 3eb6f2c (CC BY-NC 4.0)', 'blue-book': `${vaultManifest().source} ${vaultManifest().commit} (${vaultManifest().license})` },
      write_path: 'put_page (trusted local caller) on in-memory PGLite; per-line detail from the build parseLineGrammar over the stored compiled_truth with the active pack link verbs; counts cross-checked with the put_page line_grammar advisory',
      eval_config: configRecord ?? { channel: 'GBRAIN_EVAL_CONFIG', requested: config },
      ...(custody ? { custody_sha256: custody.sha256 } : {}),
    },
  });
  if (summary) receipt.cost = receiptCost(summary);
  writeReceipt(join(output, 'receipt.json'), receipt);
  log(`receipt: ${join(output, 'receipt.json')}`);
  if (receipt.run_status === 'error') { console.error(`error: ${(receipt.data as { harness_error: string }).harness_error}`); process.exit(3); }
  process.stdout.write(JSON.stringify(sum, null, 2) + '\n');
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(3); });
}
