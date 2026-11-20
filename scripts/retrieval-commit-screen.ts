#!/usr/bin/env bun
/**
 * retrieval-commit-screen.ts — daily screen of gbrain / gbrain-evals commits
 * for changes that can move retrieval results, ranking, embeddings, chunking,
 * search latency, or a storage engine (Postgres, PGLite, Rust).
 *
 * Read-only. Uses only local `git` on refs you fetched beforehand. It makes no
 * GitHub API calls, so it cannot burn the shared API budget.
 *
 * Usage (from the repository root; the full guide is scripts/retrieval-commit-screen.md):
 *   bun scripts/retrieval-commit-screen.ts --repo <checkout> --since <ISO> \
 *     --range '<label>=<rev-list args>' [--range ...] --link https://github.com/<org>/<repo> \
 *     [--kind gbrain|evals] [--json out.json] > report.md
 *
 * Example (gbrain; fetch first, the script never fetches):
 *   git -C ../gbrain fetch origin master
 *   bun scripts/retrieval-commit-screen.ts --repo ../gbrain --kind gbrain \
 *     --since "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
 *     --range 'master=origin/master' \
 *     --range 'branch (not on master)=origin/<branch> ^origin/master' \
 *     --link https://github.com/garrytan/gbrain
 *
 * Method (the same rules are in RULES below; edit them there, not here):
 *  1. Each changed file gets the FIRST matching rule's class:
 *       ignore  -> tests, docs, changelog fragments, generated bundles, CI/guards
 *       strong  -> search/ranking, embedding, chunking code (retrieval path itself)
 *       engine  -> storage-engine code that is not the retrieval path by name
 *       context -> read-path inputs (visibility/trust filters, import/sync, ops)
 *       harness -> eval harness / adapters / corpora / gbrain pin (evals repo)
 *  2. engine/context files are upgraded to strong when a changed (+/-) line
 *     matches RETRIEVAL_LINE (ts_rank, <=>, hnsw, searchKeyword, chunk_text ...);
 *     retrieval-bench harness files (evals) likewise with HARNESS_LINE.
 *     Comment-only lines never upgrade.
 *  3. Commit verdict: any strong -> yes; any engine/context/harness -> maybe;
 *     otherwise a subject that matches RETRIEVAL_SUBJECT and touches code -> maybe;
 *     else no.
 *  4. Merge commits are judged only on what the merge itself changed versus
 *     every parent (git diff-tree --cc): conflict resolutions and evil merges.
 *     The commits a merge brings in are listed on their own rows.
 */
import { spawnSync } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

type Cls = 'ignore' | 'strong' | 'engine' | 'context' | 'harness';
interface Rule { cls: Cls; area: string; re: RegExp }

export const RULES: Rule[] = [
  // ---- ignore: cannot change runtime behaviour of a bench run
  { cls: 'ignore', area: 'tests', re: /^(test|tests)\/|^rust\/crates\/[^/]+\/tests\/|\.test\.ts$|^test\/eval\// },
  { cls: 'ignore', area: 'docs', re: /^(docs|rust\/docs|changelog\.d|behavior-changes\.d|deprecations\.d|skills|plugin|plugin-variants|templates|examples|recipes)\/|\.md$|^llms[^/]*\.txt$/ },
  { cls: 'ignore', area: 'release/ci', re: /^(VERSION|openclaw\.plugin\.json)$|^\.(github|gstack|agents|claude-plugin|codex-plugin)\/|^\.gbrain-evals\// },
  { cls: 'ignore', area: 'generated registries', re: /\.generated\.ts$|^src\/core\/error-registry\.ts$/ },
  { cls: 'ignore', area: 'evals published results', re: /^(results|docs\/benchmarks|docs\/comparison-systems)\// },
  // ---- strong: the retrieval path by name
  { cls: 'strong', area: 'search/ranking', re: /^src\/core\/search\/|^src\/core\/engine-sql\/(search|keyword|cjk|graph-rank|chunk-reads|vector)[^/]*\.ts$|^src\/core\/(fts-language)\.ts$|^src\/core\/facts\/(fts-index|keyword-only)\.ts$|^src\/core\/ai\/(expansion|rerank|reranker|query-embed|decide\/rerank)[^/]*\.ts$/ },
  { cls: 'strong', area: 'search/ranking (rust)', re: /^rust\/crates\/gbrain-store\/src\/(keyword|search|chunk_queries|vector|hybrid|rank)[^/]*(\/|\.rs$)|^(src\/core\/rust-engine|rust\/crates\/gbrain-napi\/src\/families)\/[^/]*(search|keyword|vector|chunk|hybrid|rank)[^/]*$/ },
  { cls: 'strong', area: 'embeddings', re: /^src\/core\/(embedding(?!-pricing|-migration-budget)[^/]*|embed-(reuse|skip|stale|preflight|overlength-heal|oversize-heal|facts)[^/]*)\.ts$|^src\/core\/ai\/(embed[^/]*|gateway)\.ts$|^src\/core\/search\/embedding-column\.ts$/ },
  { cls: 'strong', area: 'chunking', re: /^src\/core\/chunkers\/|^src\/core\/(code-chunks|import-chunk-reuse)\.ts$|^src\/core\/engine-sql\/chunks\.ts$|^rust\/crates\/gbrain-store\/src\/chunks?\.rs$/ },
  // ---- engine: storage engine code, upgraded when a changed line is retrieval SQL
  { cls: 'engine', area: 'engine:postgres', re: /^src\/core\/postgres-engine(\.ts|\/)/ },
  { cls: 'engine', area: 'engine:pglite', re: /^src\/core\/pglite-engine(\.ts|\/)|^src\/core\/pglite-/ },
  { cls: 'engine', area: 'engine:rust', re: /^src\/core\/rust-engine(\.ts|\/)|^rust\/crates\/|^rust\/Cargo|^Cargo\.(toml|lock)$/ },
  { cls: 'engine', area: 'engine:shared sql', re: /^src\/core\/engine-sql\/|^src\/core\/engine(-factory|-capabilities)?\.ts$|^src\/core\/(statement-deadline|db|migrate|function-search-path)\.ts$/ },
  { cls: 'engine', area: 'schema', re: /^src\/schema[^/]*\.(sql|ts)$|^src\/core\/schema-migrations\/|^src\/core\/schema-fragments?\// },
  { cls: 'engine', area: 'deps', re: /^(package\.json|bun\.lock)$/ },
  // ---- context: decides what gets indexed or what a search may see
  { cls: 'context', area: 'read-path context', re: /^src\/core\/(trust|access|page-state|ops|verbs|facts|persistence)\/|^src\/core\/(import-file|operations|config|search-config)\.ts$|^src\/commands\/(sync|import|embed|query|search)[^/]*(\.ts|\/)/ },
  // ---- evals harness (only meaningful with --kind evals)
  { cls: 'harness', area: 'retrieval bench harness', re: /^eval\/runner\/(engine-bench\/|longmemeval|lme-plain-hybrid|plain-baseline|retrieval-baselines|systems\/baselines|metrics|cat13|cat18|cat21|cat22|cat26|cat27|perf|multi-adapter|before-after|smoke|types)[^/]*|^eval\/runner\/(adapters|loaders|queries)\/|^eval\/adapters\/(?!er-h2h)|^eval\/data\/(longmemeval|world|source-swamp|gold|qrels)/ },
  { cls: 'harness', area: 'shared harness', re: /^eval\/runner\/(hermetic-env|lifecycle\/|recorder|llm-budget|judge|tool-bridge|eval-engine\.ts$|gbrain-under-test\.ts$)/ },
  { cls: 'harness', area: 'scorers', re: /^eval\/runner\/evaluator\// },
  { cls: 'ignore', area: 'other benches', re: /^eval\/(runner|adapters|data|systems|loaders|generators)\/|^scripts\/ubicloud\// },
];

export const RETRIEVAL_LINE = /ts_rank|websearch_to_tsquery|plainto_tsquery|to_tsquery|tsvector|search_vector|<=>|<#>|hnsw|ivfflat|ef_search|enable_seqscan|statement_timeout|embedding|cosine|\brrf\b|reciprocal|rerank|bm25|order by score|searchKeyword|searchVector|hybridSearch|keywordCandidates|chunk_text|chunker|sealChunks|upsertChunks|best_per_page|sourceFactor|boost/i;
// for eval harness files: a changed line that can move a measured number
export const HARNESS_LINE = /top_?k\b|topK|\blimit\s*[:=]|expan(sion|d)|autocut|rerank|searchKeyword|searchVector|hybridSearch|\.search\(|\bquery\(|stratif|orFallback|orFill|any.?word|every.?word|embed(Cache|ding)|recall_?(all|any)|recallAt|ndcg|mrr|precision|goldSessions|answer_session/i;
export const RETRIEVAL_SUBJECT = /search|rank|retriev|embed|chunk|keyword|vector|hybrid|recall|latency|\bindex|stale|boost|query|bm25|ts_rank/i;

// The parsers below read exact patch text, so git's display settings are pinned here instead of read from the user's config
// (a repo or ~/.gitconfig with color.ui=always, diff.noprefix=true, diff.renames or log.showSignature must not change a verdict).
const PIN = ['--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'color.ui=never', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.renames=false', '-c', 'log.showSignature=false', '-c', 'i18n.logOutputEncoding=UTF-8'];
const PATCH = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
// GIT_NO_LAZY_FETCH=1 (git 2.44 and newer) stops a partial clone (--filter=blob:none) from fetching a missing blob
// from its promisor remote; older git ignores the variable.
export const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TZ: 'UTC', GIT_NO_LAZY_FETCH: '1' });

/** Run git; null when it exits non-zero (for a probe such as "does this blob exist"). */
function gitTry(repo: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', repo, ...PIN, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, env: gitEnv() });
  return r.error || r.status !== 0 ? null : r.stdout;
}

function git(repo: string, args: string[]): string {
  // TZ=UTC so format-local dates print in UTC, as the report's Date (UTC) column says
  const r = spawnSync('git', ['-C', repo, ...PIN, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, env: gitEnv() });
  if (r.error || r.status !== 0) {
    const why = (r.error?.message ?? r.stderr ?? '').trim().split('\n').slice(0, 3).join(' ');
    throw new ScreenError('GIT_FAILED', `git ${args.slice(0, 2).join(' ')} failed in ${repo}: ${why}`, 'check that --repo is a git checkout and that every --range ref exists there (fetch it first: git -C <repo> fetch origin <ref>)');
  }
  return r.stdout;
}
export const classify = (f: string): Rule | null => RULES.find(r => r.re.test(f)) ?? null;

/** The manifest without its top-level "version", with keys sorted so only a real change differs; undefined when the text is not a JSON object. */
function manifestKey(text: string | null): string | undefined {
  if (text === null) return '{}'; // the file is absent on that side (added or deleted)
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const { version: _version, ...rest } = v as Record<string, unknown>;
    const canon = (x: unknown): unknown => Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, y]) => [k, canon(y)])) : x;
    return JSON.stringify(canon(rest));
  } catch { return undefined; }
}

/**
 * Does this commit change package.json beyond its "version"? Compares the parsed old and new files (any layout, one line or many);
 * a merge counts only when the result differs from every parent. When either side is not valid JSON it falls back to the
 * changed-line rule: a changed line that starts with a quoted key and is not "version".
 */
function packageJsonChanged(repo: string, sha: string, merge: boolean): boolean {
  const now = gitTry(repo, ['show', `${sha}:package.json`]);
  const parents = (git(repo, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1)).filter(Boolean);
  const newKey = manifestKey(now);
  const oldKeys = (parents.length ? parents : [null]).map(pa => (pa === null ? '{}' : manifestKey(gitTry(repo, ['show', `${pa}:package.json`]))));
  if (newKey !== undefined && oldKeys.every(k => k !== undefined)) return merge ? oldKeys.every(k => k !== newKey) : oldKeys[0] !== newKey;
  return git(repo, ['show', ...PATCH, ...(merge ? ['--cc'] : []), '--format=', '-U0', sha, '--', 'package.json'])
    .split('\n').some(l => (merge ? /^(?=[ +-]*[+-])[ +-]{2}\s*"/ : /^[+-]\s*"/).test(l) && !/"version"\s*:/.test(l));
}

/** Decode a C-quoted path as git prints it in a patch header (a name with a quote, backslash or control character is quoted even with core.quotePath=false). */
function unquote(q: string): string {
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  const body = q.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue; }
    const oct = /^[0-3][0-7]{2}/.exec(body.slice(i + 1, i + 4));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; } else { bytes.push(esc[body[i + 1]] ?? body.charCodeAt(i + 1)); i++; }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path a '--- a/<path>' or '+++ b/<path>' patch header names, or null when the line is not such a header. */
function header(line: string, mark: '--- ' | '+++ ', prefix: 'a/' | 'b/'): string | null {
  if (!line.startsWith(mark)) return null;
  let rest = line.slice(mark.length).replace(/\t$/, ''); // git appends a TAB to a name that contains a space
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length > 1) rest = unquote(rest);
  return rest.startsWith(prefix) ? rest.slice(prefix.length) : null;
}

export interface Row { via?: string; sha: string; date: string; author: string; subject: string; merge: boolean; verdict: 'yes' | 'maybe' | 'no'; areas: string[]; files: string[]; reason: string }

export function screenCommit(repo: string, kind: string, sha: string, merge: boolean, subject: string): Omit<Row, 'sha' | 'date' | 'author' | 'subject' | 'merge'> {
  // -z: names come NUL-delimited and unquoted, so a name with a quote, backslash or newline is read as written
  const nameArgs = merge ? ['diff-tree', ...PATCH, '--cc', '-r', '--name-only', '-z', '--format=', sha] : ['diff-tree', ...PATCH, '--no-commit-id', '-r', '--name-only', '-z', '--root', sha];
  const files = git(repo, nameArgs).split('\0').filter(Boolean);
  const hits: { f: string; r: Rule }[] = [];
  let code = false;
  let depsMemo: boolean | undefined;
  // true when package.json changes anything but its top-level "version" (a dependency, a pin, a script)
  const depsChanged = () => depsMemo ??= files.includes('package.json') && packageJsonChanged(repo, sha, merge);
  for (const f of files) {
    const r = classify(f);
    if (r?.cls === 'ignore') continue;
    if (!r) { if (/\.(ts|rs|sql|js|mjs)$/.test(f) && !/^scripts\//.test(f)) code = true; continue; }
    if (r.cls === 'harness' && kind !== 'evals') continue;
    if (f === 'package.json' && !depsChanged()) continue; // version-stamp-only bump; bun.lock changes always count
    code = true;
    hits.push({ f, r });
  }
  // gbrain pin in evals package.json is a strong signal for the bench
  if (kind === 'evals' && files.includes('package.json')) {
    const d = git(repo, ['show', ...PATCH, '--format=', '-U0', sha, '--', 'package.json']);
    if (/^[-+].*"gbrain"\s*:/m.test(d)) hits.push({ f: 'package.json', r: { cls: 'strong', area: 'gbrain pin', re: /x/ } });
  }
  // upgrade engine/context files whose changed lines touch retrieval SQL/code
  const toScan = hits.filter(h => h.r.cls === 'engine' || h.r.cls === 'context' || h.r.cls === 'harness').map(h => h.f).filter(f => f !== 'bun.lock');
  const lineRe = (f: string) => (classify(f)?.cls === 'harness' ? HARNESS_LINE : RETRIEVAL_LINE);
  const upgraded = new Set<string>();
  if (toScan.length) {
    const diff = git(repo, ['show', ...PATCH, ...(merge ? ['--cc'] : []), '--format=', '-U0', sha, '--', ...toScan]);
    let cur = '';
    let was = ''; // the '--- a/<path>' header, which names a deleted file ('+++ /dev/null')
    for (const line of diff.split('\n')) {
      const old = header(line, '--- ', 'a/'); if (old !== null) { was = old; continue; }
      const m = header(line, '+++ ', 'b/'); if (m !== null) { cur = m; continue; }
      if (line === '+++ /dev/null') { cur = was; continue; }
      if (/^(\+\+\+|---) /.test(line)) continue;
      const w = merge ? 2 : 1; // --cc prefixes one column per parent
      if (/[+-]/.test(line.slice(0, w))) {
        const body = line.slice(w).trim();
        if (/^(\/\/|\/\*|\*|#|--)/.test(body)) continue; // comment lines (SQL '--' too) never upgrade
        if (lineRe(cur).test(body)) upgraded.add(cur);
      }
    }
  }
  const strong = hits.filter(h => h.r.cls === 'strong' || upgraded.has(h.f));
  const soft = hits.filter(h => !strong.includes(h));
  const areas = [...new Set(hits.map(h => h.r.area + (upgraded.has(h.f) ? '+sql' : '')))];
  let verdict: Row['verdict'] = 'no';
  let reason = '';
  const top = (hs: typeof hits) => hs.slice(0, 3).map(h => h.f.replace(/^src\/core\//, '').replace(/^rust\/crates\//, 'rust/')).join(', ') + (hs.length > 3 ? ` (+${hs.length - 3})` : '');
  if (strong.length) { verdict = 'yes'; reason = `${[...new Set(strong.map(h => h.r.area))].join('/')}: ${top(strong)}`; }
  else if (soft.length) { verdict = 'maybe'; reason = `${[...new Set(soft.map(h => h.r.area))].join('/')}: ${top(soft)}`; }
  else if (code && RETRIEVAL_SUBJECT.test(subject)) { verdict = 'maybe'; reason = 'subject names retrieval; code outside mapped paths'; }
  return { verdict, areas, files, reason };
}

const USAGE = 'usage: bun scripts/retrieval-commit-screen.ts --repo <checkout> --since <ISO> --range <label>=<rev-list args> [--range ...] --link https://github.com/<org>/<repo> [--kind gbrain|evals] [--json out.json]';
const VALUE_OPTS = new Set(['--repo', '--since', '--range', '--link', '--kind', '--json']);

/** Thrown for a bad command line (exit 2) or a failed git call / JSON write (exit 1). */
export class ScreenError extends Error {
  constructor(readonly code: 'USAGE' | 'GIT_FAILED' | 'JSON_WRITE_FAILED', message: string, readonly fix: string) { super(message); }
}

export interface Options { repo: string; since: string; link: string; kind: 'gbrain' | 'evals'; json?: string; ranges: { label: string; revs: string[] }[] }

/** Parse argv strictly: every option takes a value, no option repeats except --range, unknown flags are refused. */
export function parseArgs(argv: string[]): Options {
  const seen = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!VALUE_OPTS.has(k)) throw new ScreenError('USAGE', `unknown argument ${JSON.stringify(k)}`, USAGE);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ScreenError('USAGE', `${k} needs a value`, USAGE);
    if (k !== '--range' && seen.has(k)) throw new ScreenError('USAGE', `${k} given twice`, USAGE);
    seen.set(k, [...(seen.get(k) ?? []), v]);
    i++;
  }
  const one = (k: string) => seen.get(k)?.[0];
  const repo = one('--repo'), since = one('--since'), link = one('--link'), kind = one('--kind') ?? 'gbrain';
  const missing = ['--repo', '--since', '--link', '--range'].filter(k => !seen.has(k));
  if (missing.length) throw new ScreenError('USAGE', `missing ${missing.join(', ')}`, USAGE);
  if (kind !== 'gbrain' && kind !== 'evals') throw new ScreenError('USAGE', `--kind must be gbrain or evals, not ${JSON.stringify(kind)}`, USAGE);
  if (Number.isNaN(Date.parse(since!))) throw new ScreenError('USAGE', `--since ${JSON.stringify(since)} is not an ISO date`, 'pass a date such as 2026-01-01T00:00:00Z');
  const ranges = seen.get('--range')!.map(spec => {
    const [label, revs] = spec.split(/=(.*)/s);
    if (!label || !revs?.trim()) throw new ScreenError('USAGE', `bad --range ${JSON.stringify(spec)}`, 'write --range \'<label>=<rev-list args>\', for example --range \'master=origin/master\'');
    const toks = revs.trim().split(/\s+/);
    // a token that starts with '-' would be read by git as an option (for example --output=<file>), never as a revision
    const opt = toks.find(t => t.startsWith('-'));
    if (opt) throw new ScreenError('USAGE', `--range ${JSON.stringify(spec)} has ${JSON.stringify(opt)}, which git would read as an option`, 'write only revisions here, such as origin/master or ^origin/master');
    return { label, revs: toks };
  });
  const labels = ranges.map(r => r.label);
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup !== undefined) throw new ScreenError('USAGE', `--range label ${JSON.stringify(dup)} is used twice`, 'give each --range its own label; the --json file is keyed by label');
  return { repo: repo!, since: since!, link: link!, kind, json: one('--json'), ranges };
}

export function run(o: Options): { md: string; out: Record<string, Row[]> } {
  const out: Record<string, Row[]> = Object.create(null); // a label such as __proto__ must become a key, not change the prototype
  let md = `Screen window: commits with committer date since ${o.since}. Rules: scripts/retrieval-commit-screen.ts RULES.\n`;
  for (const { label, revs } of o.ranges) {
    const log = git(o.repo, ['log', `--since=${o.since}`, '--date=format-local:%Y-%m-%dT%H:%M:%SZ', '--format=%H%x1f%cd%x1f%an%x1f%P%x1f%s', ...revs, '--']);
    const rows: Row[] = [];
    const listed = new Set<string>();
    const parse = (l: string, via?: string) => {
      const [sha, date, author, parents, subject] = l.split('\x1f');
      const merge = parents.trim().split(' ').length > 1;
      listed.add(sha);
      rows.push({ ...(via ? { via } : {}), sha, date, author, subject, merge, ...screenCommit(o.repo, o.kind, sha, merge, subject) });
      return { sha, merge };
    };
    const fmt = '--format=%H%x1f%cd%x1f%an%x1f%P%x1f%s';
    const dateFmt = '--date=format-local:%Y-%m-%dT%H:%M:%SZ';
    const skip = revs.filter(r => r.startsWith('^'));
    const lines = log.split('\n').filter(Boolean);
    const inWindow = new Set(lines.map(l => l.split('\x1f')[0]));
    for (const l of lines) {
      const { sha, merge } = parse(l);
      if (!merge) continue;
      // git log --since filters by committer date, so work merged today can be older than the window: screen what this merge brought in too
      const brought = git(o.repo, ['log', dateFmt, fmt, sha, `^${sha}^1`, ...skip, '--']).split('\n').filter(Boolean);
      for (const x of brought) if (!inWindow.has(x.split('\x1f')[0]) && !listed.has(x.split('\x1f')[0])) parse(x, sha);
    }
    out[label] = rows;
    const c = (v: string) => rows.filter(r => r.verdict === v).length;
    md += `\n### ${label}\n\n${rows.length} commits (${rows.filter(r => r.merge).length} merges${rows.some(r => r.via) ? `, ${rows.filter(r => r.via).length} older than the window, brought in by a merge` : ''}): yes ${c('yes')}, maybe ${c('maybe')}, no ${c('no')}\n\n| SHA | Date (UTC) | Title | Author | Tag | Reason |\n|---|---|---|---|---|---|\n`;
    for (const r of rows) {
      const t = r.subject.replace(/\|/g, '\\|');
      md += `| [${r.sha.slice(0, 10)}](${o.link}/commit/${r.sha}) | ${r.date.slice(0, 16).replace('T', ' ')} | ${r.merge ? '(merge) ' : ''}${r.via ? `(via merge ${r.via.slice(0, 10)}) ` : ''}${t} | ${r.author.replace(/\|/g, '\\|')} | ${r.verdict} | ${r.verdict === 'no' ? '' : r.reason.replace(/\|/g, '\\|')} |\n`;
    }
  }
  return { md, out };
}

/** Write the JSON next to its target, then rename, so a failed write never leaves a partial file. */
function writeJson(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(data, null, 2)); renameSync(tmp, path); }
  catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw new ScreenError('JSON_WRITE_FAILED', `cannot write ${path}: ${(e as Error).message}`, 'pass a --json path in a directory that exists and is writable; no partial file was left behind');
  }
}

function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    const { md, out } = run(o);
    // JSON first: when it fails, the report is not printed, so a caller never mistakes a half run for a whole one
    if (o.json) writeJson(o.json, out);
    process.stdout.write(md);
  } catch (e) {
    if (!(e instanceof ScreenError)) throw e;
    console.error(`retrieval-commit-screen: ${e.code}: ${e.message}\nfix: ${e.fix}`);
    process.exit(e.code === 'USAGE' ? 2 : 1);
  }
}
if (import.meta.main) main();
