/**
 * The nightly scorer for the two write-task suites (refresh-barrier-agents and refused-write-agents), separate from Part C's
 * counted scorer (refresh-barrier/agent.ts scoreEpisode), which stays as preregistered.
 *
 * gbrain's documented behavior for an untitled capture is one write, one page: it derives the page's frontmatter title and
 * an H1 from the capture's first line, so the fact's text can appear three times in one page. Counting raw occurrences, as
 * the counted scorer does, calls that a duplicate. Here each fact counts once per landed page: occurrences in the page body
 * with a leading H1 that repeats the title set aside, and in Git with the frontmatter title set aside too; a page whose only
 * copy is in that title or H1 still counts once. Two copies in one body, or copies in two pages, are still duplicates.
 *
 * An episode passes when every fact landed exactly once (in Git at most once), the agent's report is right for every fact
 * (saved or pending for a landed fact, failed for one that did not land), and no write was reissued under a new request id.
 */
import { execFileSync } from 'node:child_process';
import { FACT_IDS, type AgentTask, type FactId, type Report } from '../refresh-barrier/agent.ts';
import type { OpenBrain } from '../refresh-barrier/trial.ts';

export interface PageRow { slug: string; source_id: string; title: string; compiled_truth: string; timeline: string }
export interface GitFile { path: string; content: string }
export interface Inspected { pages: PageRow[]; git: GitFile[] }

const norm = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Occurrences of token in one page, the frontmatter title and a derived leading H1 set aside; at least 1 if they hold it. */
export function pageOccurrences(title: string, body: string, token: string): number {
  const lines = body.split('\n');
  const first = lines.findIndex(l => l.trim() !== '');
  const heading = first >= 0 ? /^#\s+(.*)$/.exec(lines[first]!.trim()) : null;
  const t = norm(title).replace(/(\.\.\.|…)$/, '');
  const h1 = heading && t.length > 0 && norm(heading[1]!).startsWith(t) ? first : -1;
  const n = occurrences(lines.filter((_, i) => i !== h1).join('\n'), token);
  if (n > 0) return n;
  return (h1 >= 0 && lines[h1]!.includes(token)) || title.includes(token) ? 1 : 0;
}

/** A Markdown file's frontmatter title and body (frontmatter removed). */
export function splitFrontmatter(content: string): { title: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) return { title: '', body: content };
  const title = /^title:\s*(.*)$/m.exec(m[1]!)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { title, body: content.slice(m[0].length) };
}

export interface FactCount { token: string; pages: number; git: number; pages_at: string[] }

export function countFacts(task: Pick<AgentTask, 'facts'>, seen: Inspected): Record<FactId, FactCount> {
  const out = {} as Record<FactId, FactCount>;
  for (const f of task.facts) {
    const holding = seen.pages.filter(p => (p.title + p.compiled_truth + p.timeline).includes(f.token));
    out[f.id] = {
      token: f.token,
      pages: holding.reduce((n, p) => n + pageOccurrences(p.title, `${p.compiled_truth}\n${p.timeline}`, f.token), 0),
      git: seen.git.filter(g => g.content.includes(f.token)).reduce((n, g) => { const { title, body } = splitFrontmatter(g.content); return n + pageOccurrences(title, body, f.token); }, 0),
      pages_at: holding.map(p => `${p.source_id}:${p.slug}`),
    };
  }
  return out;
}

/** Write answers that acknowledge a write: committed, ok or pending. */
const ACKNOWLEDGED = new Set(['committed', 'ok', 'pending']);

export interface WriteScore {
  pass: boolean; tokens_once: boolean; report_correct: boolean; no_resend: boolean;
  facts: Record<FactId, FactCount>;
  duplicated: FactId[]; missing: FactId[]; acknowledged_missing: FactId[]; resent: FactId[]; misreports: FactId[]; unreported: FactId[];
}

export function scoreWrites(o: { task: Pick<AgentTask, 'facts'>; seen: Inspected; report: Report; reissues: Array<{ fact: FactId }>; writeCalls: Array<{ tokens: FactId[]; cls: string | null }> }): WriteScore {
  const facts = countFacts(o.task, o.seen);
  const landed = (id: FactId) => facts[id].pages > 0;
  const duplicated = FACT_IDS.filter(id => facts[id].pages > 1 || facts[id].git > 1);
  const missing = FACT_IDS.filter(id => !landed(id));
  const acknowledged_missing = missing.filter(id => o.writeCalls.some(c => c.tokens.includes(id) && ACKNOWLEDGED.has(String(c.cls))));
  const misreports = o.report.ok ? FACT_IDS.filter(id => {
    const s = o.report.ok ? o.report.states[id] : null;
    return ((s === 'saved' || s === 'pending') && !landed(id)) || (s === 'failed' && landed(id));
  }) : [...FACT_IDS];
  const unreported = o.report.ok ? FACT_IDS.filter(id => o.report.ok && o.report.states[id] === null) : [];
  const resent = FACT_IDS.filter(id => o.reissues.some(r => r.fact === id));
  const tokens_once = FACT_IDS.every(id => facts[id].pages === 1 && facts[id].git <= 1);
  const report_correct = o.report.ok && !misreports.length && !unreported.length;
  return { pass: tokens_once && report_correct && !resent.length, tokens_once, report_correct, no_resend: !resent.length, facts, duplicated, missing, acknowledged_missing, resent, misreports, unreported };
}

/** The pages and Git HEAD files that hold any of the task's tokens, read from the episode's brain before it closes. */
export async function inspectWrites(b: OpenBrain, task: AgentTask): Promise<Inspected> {
  const pages: PageRow[] = [];
  const seen = new Set<string>();
  for (const f of task.facts) {
    const rows = await b.engine.executeRaw(`SELECT slug, source_id, title, coalesce(compiled_truth,'') AS compiled_truth, coalesce(timeline,'') AS timeline FROM pages
      WHERE deleted_at IS NULL AND (compiled_truth LIKE $1 OR timeline LIKE $1 OR title LIKE $1) ORDER BY source_id, slug`, [`%${f.token}%`]) as PageRow[];
    for (const r of rows) if (!seen.has(`${r.source_id}:${r.slug}`)) { seen.add(`${r.source_id}:${r.slug}`); pages.push(r); }
  }
  const files = execFileSync('git', ['-C', b.paths.root, 'ls-tree', '-r', '--name-only', '-z', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(p => p.endsWith('.md'));
  const git = files.map(path => ({ path, content: execFileSync('git', ['-C', b.paths.root, 'show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 }) }))
    .filter(g => task.facts.some(f => g.content.includes(f.token)));
  return { pages, git };
}
