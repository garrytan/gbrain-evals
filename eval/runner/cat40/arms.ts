/**
 * Cat 40 memory arms. Each arm offers one way to reach the same corpus.
 *
 *   oracle   no tools; the task's planted documents are in the prompt
 *   fs       list_dir / grep / read_file / write_file over Markdown files
 *   fs-acl   fs with finance-only files removed for the acting user
 *   memory   Anthropic's memory tool (`memory_20250818`) over the same files
 *            in /memories; the same commands as a function for other models
 *   pg       plain Postgres: full-text and pgvector search over whole
 *            documents, get_document, save_document
 *   gbrain   gbrain's MCP server (stdio, `--surface starter`), see gbrain-arm.ts
 *
 * Writes never touch the shared corpus. File arms and pg write to a per-run
 * overlay, so a later task never sees an earlier run's notes.
 */
import type { Arm, ToolSpec } from './loop.ts';
import type { LadderDoc, LadderTask, LadderWorld } from '../../generators/model-ladder-gen.ts';
import { renderDoc } from '../../generators/model-ladder-gen.ts';
import { grepWorkerFor, HARD_GREP_TIMEOUT_MS } from './hard-grep.ts';

export type ArmName = 'oracle' | 'fs' | 'fs-acl' | 'memory' | 'pg' | 'gbrain';
export const ALL_ARMS: readonly ArmName[] = ['oracle', 'fs', 'fs-acl', 'memory', 'pg', 'gbrain'];

/**
 * Tool limits (plan 2026-10-05, CEO-T4, DX-F10, DX-F11). `v1` keeps the limits every v1 and large result was
 * measured with; `hard` (Hard worlds only) lifts them: grep returns every match with full lines and its total,
 * pg searches page with `offset` up to 100 rows and report their total and whether the results are exhausted.
 */
export type ToolLimits = 'v1' | 'hard';
/** fs grep limits per tool-limit setting (null: no limit). The tool descriptions state these. */
export const GREP_LIMITS: Record<ToolLimits, { defaultResults: number | null; maxResults: number | null; lineChars: number | null }> = {
  v1: { defaultResults: 50, maxResults: 200, lineChars: 300 },
  hard: { defaultResults: null, maxResults: null, lineChars: null },
};

/** Normalize a path, slug or id an agent cites to a corpus doc id. */
export function normalizeDocRef(ref: string): string {
  return ref.trim().replace(/^\/?memories\//, '').replace(/^\.?\//, '').replace(/^corpus\//, '').replace(/\.md$/, '').replace(/#.*$/, '').toLowerCase();
}

// ─── File-backed arms ───────────────────────────────────────────────

export class FileStore {
  readonly overlay = new Map<string, string | null>();
  constructor(readonly base: Map<string, string>) {}
  static fromWorld(world: LadderWorld, filter: (d: LadderDoc) => boolean = () => true): FileStore {
    return new FileStore(new Map(world.docs.filter(filter).map(d => [`${d.id}.md`, renderDoc(d)])));
  }
  get(path: string): string | undefined {
    if (this.overlay.has(path)) return this.overlay.get(path) ?? undefined;
    return this.base.get(path);
  }
  set(path: string, content: string | null) { this.overlay.set(path, content); }
  paths(): string[] {
    const all = new Set([...this.base.keys(), ...this.overlay.keys()]);
    return [...all].filter(p => this.get(p) !== undefined).sort();
  }
}

function cleanPath(p: unknown): string {
  const s = String(p ?? '').trim().replace(/^\/?memories\/?/, '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (s.split('/').includes('..')) throw new Error('path traversal is not allowed');
  return s;
}

function listDir(store: FileStore, dir: string): string[] {
  const prefix = dir ? `${dir}/` : '';
  const out = new Set<string>();
  for (const p of store.paths()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf('/');
    out.add(i >= 0 ? `${rest.slice(0, i)}/` : rest);
  }
  return [...out].sort();
}

export interface FsArmOptions {
  /** Default `v1`. */
  limits?: ToolLimits;
  /** Per-call time limit of the Hard grep worker (default 20 s). */
  grepTimeoutMs?: number;
}

/** The Hard grep tool: every match, full lines, total; `max_results` optionally caps what is shown. */
export const HARD_GREP_TOOL: ToolSpec = {
  name: 'grep',
  description: `Search file contents with a regular expression, like ripgrep. Returns every matching line in full as path:line: text, then the total on a final line "[N matches]". max_results is optional: when given, only the first max_results matches are shown and the final line still counts every match ("[N matches; showing the first K]"). A search that runs longer than ${HARD_GREP_TIMEOUT_MS / 1000} s is stopped with an error; use a simpler pattern or a narrower path.`,
  input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory or file to search; default the root.' }, ignore_case: { type: 'boolean', description: 'Default true.' }, max_results: { type: 'number', description: 'Optional cap on matches shown; default every match.' } }, required: ['pattern'] },
};

export class FsArm implements Arm {
  readonly limits: ToolLimits;
  constructor(readonly name: 'fs' | 'fs-acl', readonly store: FileStore, private options: FsArmOptions = {}) { this.limits = options.limits ?? 'v1'; }
  systemHint() {
    return 'The knowledge base is a directory of Markdown files with YAML frontmatter. Use list_dir, grep and read_file to find information. Use write_file to save new notes.';
  }
  tools(): ToolSpec[] {
    const tools = this.v1Tools();
    return this.limits === 'hard' ? tools.map(t => t.name === 'grep' ? HARD_GREP_TOOL : t) : tools;
  }
  private v1Tools(): ToolSpec[] {
    return [
      { name: 'list_dir', description: 'List the entries of one directory (not recursive). Directories end with /.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to the knowledge base root; "." for the root.' } } } },
      { name: 'grep', description: 'Search file contents with a regular expression, like ripgrep. Returns matching lines as path:line: text.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory or file to search; default the root.' }, ignore_case: { type: 'boolean', description: 'Default true.' }, max_results: { type: 'number', description: 'Default 50.' } }, required: ['pattern'] } },
      { name: 'read_file', description: 'Read a whole file.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'write_file', description: 'Create or replace a file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    ];
  }
  writeTools() { return ['write_file']; }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'list_dir') {
      const dir = cleanPath(args.path === '.' ? '' : args.path);
      const entries = listDir(this.store, dir);
      return entries.length ? entries.join('\n') : `No such directory or empty: ${dir || '.'}`;
    }
    if (name === 'grep' && this.limits === 'hard') {
      const flags = args.ignore_case === false ? '' : 'i';
      const pattern = String(args.pattern ?? '');
      try { new RegExp(pattern, flags); } catch (e) { return `Invalid regular expression: ${(e as Error).message}`; }
      const max = Math.floor(Number(args.max_results));
      return grepWorkerFor(this.store.base).grep({
        pattern, flags, scope: cleanPath(args.path === '.' ? '' : args.path), max: max > 0 ? max : null, overlay: [...this.store.overlay],
      }, this.options.grepTimeoutMs);
    }
    if (name === 'grep') {
      const flags = args.ignore_case === false ? '' : 'i';
      let re: RegExp;
      try { re = new RegExp(String(args.pattern ?? ''), flags); } catch (e) { return `Invalid regular expression: ${(e as Error).message}`; }
      const scope = cleanPath(args.path === '.' ? '' : args.path);
      const max = Math.min(200, Number(args.max_results ?? 50) || 50);
      const out: string[] = [];
      let total = 0;
      for (const p of this.store.paths()) {
        if (scope && p !== scope && !p.startsWith(`${scope}/`)) continue;
        const lines = this.store.get(p)!.split('\n');
        lines.forEach((line, i) => {
          if (!re.test(line)) return;
          total++;
          if (out.length < max) out.push(`${p}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
        });
      }
      if (!total) return 'No matches.';
      return out.join('\n') + (total > out.length ? `\n[${total - out.length} more matches not shown]` : '');
    }
    if (name === 'read_file') {
      const p = cleanPath(args.path);
      return this.store.get(p) ?? this.store.get(`${p}.md`) ?? `No such file: ${p}`;
    }
    if (name === 'write_file') {
      const p = cleanPath(args.path);
      this.store.set(p, String(args.content ?? ''));
      return `Wrote ${p}.`;
    }
    throw new Error(`unknown tool ${name}`);
  }
}

/** Anthropic memory tool semantics over the same files, rooted at /memories. */
export class MemoryArm implements Arm {
  readonly name = 'memory';
  constructor(readonly store: FileStore) {}
  systemHint() {
    return 'The knowledge base is your memory directory /memories, a tree of Markdown files with YAML frontmatter. Use the memory tool to view directories and files and to save new notes.';
  }
  nativeAnthropic() { return [{ type: 'memory_20250818', name: 'memory' }]; }
  tools(): ToolSpec[] {
    return [{
      name: 'memory', description: 'Memory directory tool. Commands: view (a directory lists files up to 2 levels deep; a file returns numbered lines, optional view_range [start, end]), create (path, file_text), str_replace (path, old_str, new_str), insert (path, insert_line, insert_text), delete (path), rename (old_path, new_path). All paths start with /memories.',
      input_schema: { type: 'object', properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] }, path: { type: 'string' },
        view_range: { type: 'array', items: { type: 'number' } }, file_text: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' },
        insert_line: { type: 'number' }, insert_text: { type: 'string' }, old_path: { type: 'string' }, new_path: { type: 'string' },
      }, required: ['command'] },
    }];
  }
  writeTools() { return ['memory:create', 'memory:str_replace', 'memory:insert', 'memory:delete', 'memory:rename']; }
  async call(_name: string, a: Record<string, unknown>): Promise<string> {
    const cmd = String(a.command ?? '');
    const p = cleanPath(a.path);
    const shown = `/memories${p ? `/${p}` : ''}`;
    if (cmd === 'view') {
      const file = this.store.get(p);
      if (file !== undefined) {
        const lines = file.split('\n');
        const [s, e] = Array.isArray(a.view_range) ? (a.view_range as number[]) : [1, lines.length];
        const end = e === -1 ? lines.length : e;
        return `Here's the content of ${shown} with line numbers:\n` + lines.slice(s - 1, end).map((l, i) => `${String(s + i).padStart(6)}\t${l}`).join('\n');
      }
      const prefix = p ? `${p}/` : '';
      const entries = new Set<string>();
      for (const path of this.store.paths()) {
        if (!path.startsWith(prefix)) continue;
        const parts = path.slice(prefix.length).split('/');
        entries.add(parts.slice(0, 2).join('/') + (parts.length > 2 ? '/' : ''));
        if (parts.length > 1) entries.add(`${parts[0]}/`);
      }
      if (!entries.size) return `The path ${shown} does not exist. Please provide a valid path.`;
      const size = (rel: string) => rel.endsWith('/') ? '4.0K' : `${(this.store.get(prefix + rel)!.length / 1024).toFixed(1)}K`;
      return `Here're the files and directories up to 2 levels deep in ${shown}, excluding hidden items and node_modules:\n4.0K\t${shown}\n`
        + [...entries].sort().map(r => `${size(r)}\t${shown}/${r.replace(/\/$/, '')}`).join('\n');
    }
    if (cmd === 'create') { this.store.set(p, String(a.file_text ?? '')); return `File created successfully at: ${shown}`; }
    const cur = this.store.get(p);
    if (cmd === 'rename') {
      const from = cleanPath(a.old_path), to = cleanPath(a.new_path);
      const v = this.store.get(from);
      if (v === undefined) return `Error: The path /memories/${from} does not exist`;
      this.store.set(to, v); this.store.set(from, null);
      return `Successfully renamed /memories/${from} to /memories/${to}`;
    }
    if (cur === undefined) return `Error: The path ${shown} does not exist`;
    if (cmd === 'str_replace') {
      const old = String(a.old_str ?? '');
      const n = cur.split(old).length - 1;
      if (n !== 1) return n === 0 ? `No replacement was performed, old_str \`${old}\` did not appear verbatim in ${shown}.` : `No replacement was performed. Multiple occurrences of old_str \`${old}\`. Please ensure it is unique`;
      this.store.set(p, cur.replace(old, String(a.new_str ?? '')));
      return 'The memory file has been edited.';
    }
    if (cmd === 'insert') {
      const lines = cur.split('\n');
      lines.splice(Number(a.insert_line ?? 0), 0, String(a.insert_text ?? ''));
      this.store.set(p, lines.join('\n'));
      return `The file ${shown} has been edited.`;
    }
    if (cmd === 'delete') { this.store.set(p, null); return `Successfully deleted ${shown}`; }
    return `Error: unknown command ${cmd}`;
  }
}

// ─── Oracle ─────────────────────────────────────────────────────────

export class OracleArm implements Arm {
  readonly name = 'oracle';
  systemHint() { return 'The relevant documents from the knowledge base are included in the request. You have no search tools.'; }
  tools(): ToolSpec[] { return []; }
  writeTools() { return []; }
  async call(name: string): Promise<string> { throw new Error(`oracle has no tool ${name}`); }
  static evidence(world: LadderWorld, task: LadderTask): string {
    const byId = new Map(world.docs.map(d => [d.id, d]));
    // The ideal permissioned layer: nothing finance-only, nothing derived from it.
    const docs = task.relevant.map(id => byId.get(id)!).filter(d => !d.restricted && !(d.derived_from ?? []).some(x => byId.get(x)?.restricted));
    const parts = docs.map(d => `<document id="${d.id}">\n${renderDoc(d)}</document>`);
    // What an ideal write-back store holds after session 1: the correction as a dated note, not the instruction to record it.
    if (task.family === 'F') parts.push(`<document id="notes/${task.id.toLowerCase()}-billing-contact-update">\n---\ntitle: "Billing contact update"\ntype: note\ndate: ${world.today}\nauthor: "${world.principal.name}"\n---\nRecorded ${world.today} from a team update: ${task.gold.answer![0]} is now the billing contact for ${(byId.get(`crm/${task.account}`)?.title ?? '').replace('CRM record: ', '')}; ${task.gold.wrong![0]} moved to another role.\n</document>`);
    return parts.join('\n\n');
  }
}

/** True when a recorded tool call targets a doc id (used for protected-record checks). */
export function callTargets(name: string, args: Record<string, unknown>): string[] {
  const refs = [args.path, args.slug, args.id, args.old_path, args.new_path].filter(v => typeof v === 'string') as string[];
  return refs.map(normalizeDocRef);
}

export function isWriteCall(arm: Arm, name: string, args: Record<string, unknown>): boolean {
  const w = arm.writeTools();
  return w.includes(name) || w.includes(`${name}:${String(args.command ?? '')}`);
}
