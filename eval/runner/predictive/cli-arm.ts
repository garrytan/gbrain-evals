/**
 * The agent-stack arms for the predictive measures (GBEV-55, gate change E1): a synthetic brain built with the gbrain
 * under test, a CLI arm that offers one `gbrain` tool taking an argv array, and an MCP arm on the same brain.
 *
 * Wintermute, the agent that runs the real brain, makes about 1,300 gbrain CLI calls for every 5 MCP searches, so the
 * write-contract tasks run on both surfaces and the other agent tasks on the CLI.
 *
 * Sandbox (E1):
 *   - The brain lives in the GBRAIN_HOME that enterHermeticEnv creates, applied to a copy of the environment, so this
 *     process keeps its own variables while every gbrain process sees only the synthetic brain.
 *   - gbrain processes get an allowlisted environment: PATH, locale, HOME and GBRAIN_HOME both set to the temp home, a
 *     hermetic Git config and self-upgrade off. No provider key or endpoint is ever passed, so gbrain has no model to
 *     call. Without `--brain` gbrain falls back to the host brain under GBRAIN_HOME, which is the synthetic one.
 *   - The CLI tool runs `bun <root>/src/cli.ts ...argv` with execFile and no shell, so quotes, pipes, `;`, `$(...)` and
 *     backticks reach gbrain as literal argument text.
 *
 * The model side of an episode is cat40's toolLoop (eval/runner/cat40/loop.ts); the MCP arm drives cat40's McpClient
 * against `gbrain serve` on the same brain.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { McpClient } from '../cat40/gbrain-arm.ts';
import type { Arm, ToolSpec } from '../cat40/loop.ts';
import { resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { assertSystemOneOff, enterHermeticEnv, strippedKeysIn, type HermeticEnv } from '../hermetic-env.ts';

export const GBRAIN_CLI_TOOL: ToolSpec = {
  name: 'gbrain',
  description: 'Run the gbrain command line against the knowledge base. Pass every argument as its own array element, without the leading gbrain (for example ["get", "people/ana-example"]). No shell runs: quotes, pipes and $(...) are passed literally. Use stdin for page content with put. Start with ["--help"] or ["<command>", "--help"] to see the commands.',
  input_schema: {
    type: 'object',
    properties: {
      argv: { type: 'array', items: { type: 'string' }, description: 'Arguments after gbrain, one per element.' },
      stdin: { type: 'string', description: 'Optional text sent on standard input, such as Markdown for put.' },
    },
    required: ['argv'],
  },
};

export const MAX_ARGV = 64;
export const MAX_ARG_CHARS = 8000;
export const CLI_TIMEOUT_MS = 120_000;
/** gbrain's stdout and stderr per call are capped here before the loop's own result cap. */
const MAX_OUTPUT_CHARS = 60_000;

export interface Page { slug: string; markdown: string }

/** One gbrain call an arm made: what the scorers read. */
export interface ArmCall {
  surface: 'cli' | 'mcp';
  /** CLI: the argv; MCP: [tool name]. */
  argv: string[];
  args?: Record<string, unknown>;
  exit: number | null;
  output: string;
  ms: number;
}

/** The environment a gbrain process gets: an allowlist, never the caller's environment minus some names. */
export function brainChildEnv(home: string, source: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: source.LANG ?? 'C.UTF-8',
    HOME: home,
    GBRAIN_HOME: home,
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    TZ: 'UTC',
    TMPDIR: join(home, 'tmp'),
  };
  const leaked = strippedKeysIn(env);
  if (leaked.length) throw new Error(`brainChildEnv would pass provider variables ${leaked.join(', ')}`);
  return env;
}

/** Checks a tool call's argv before anything runs: an array of at most MAX_ARGV strings without NUL bytes. */
export function validateArgv(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('argv must be an array of strings, one per argument');
  if (value.length === 0) throw new Error('argv is empty; pass at least a command, for example ["--help"]');
  if (value.length > MAX_ARGV) throw new Error(`argv has ${value.length} elements; at most ${MAX_ARGV}`);
  const argv = value.map((a, i) => {
    if (typeof a !== 'string') throw new Error(`argv[${i}] is not a string`);
    if (a.includes('\0')) throw new Error(`argv[${i}] contains a NUL byte`);
    if (a.length > MAX_ARG_CHARS) throw new Error(`argv[${i}] is longer than ${MAX_ARG_CHARS} characters`);
    return a;
  });
  return argv[0] === 'gbrain' ? argv.slice(1) : argv;
}

function capText(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[gbrain output truncated: ${text.length - MAX_OUTPUT_CHARS} more characters]`;
}

/** Runs the build's CLI by absolute path with execFile and no shell. Never rejects: failures come back as exit codes. */
export function execGbrain(gut: GbrainUnderTest, env: NodeJS.ProcessEnv, argv: string[], stdin?: string, timeoutMs = CLI_TIMEOUT_MS): Promise<{ exit: number | null; stdout: string; stderr: string; ms: number }> {
  const t0 = Date.now();
  return new Promise(resolve => {
    const child = execFile('bun', ['--no-env-file', join(gut.root, 'src/cli.ts'), ...argv], { env, cwd: env.GBRAIN_HOME, shell: false, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        const exit = !error ? 0 : typeof code === 'number' ? code : null;
        resolve({ exit, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (error && exit === null ? `\n[gbrain-cli] ${error.message}` : ''), ms: Date.now() - t0 });
      });
    child.stdin?.end(stdin ?? '');
  });
}

const GITCONFIG = '[user]\n\tname = Example\n\temail = example@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\thooksPath = /dev/null\n';

/** Pages and saved facts as the brain holds them, read through the CLI (export plus recall). */
export interface BrainSnapshot {
  pages: Record<string, string>;
  facts: Array<{ id: string; entity: string; fact: string }>;
}

/**
 * A fictional brain in a hermetic GBRAIN_HOME, built with the gbrain under test (`--gbrain <checkout>@<commit>` or the
 * package.json pin). Content lives in a Git checkout, so write-contract tasks can stage a committed change that gbrain
 * has not imported yet.
 */
export class SyntheticBrain {
  private constructor(readonly gut: GbrainUnderTest, readonly hermetic: HermeticEnv, readonly env: NodeJS.ProcessEnv) {}
  get home(): string { return this.hermetic.home; }
  get contentRoot(): string { return join(this.hermetic.home, 'brain'); }

  static async create(label: string, pages: readonly Page[], opts: { gut?: GbrainUnderTest } = {}): Promise<SyntheticBrain> {
    const gut = opts.gut ?? resolveGbrainUnderTest(null);
    const scratch: Record<string, string | undefined> = { ...process.env };
    const hermetic = enterHermeticEnv(label, scratch);
    try {
      assertSystemOneOff(hermetic.home, scratch);
      const env = brainChildEnv(hermetic.home, scratch);
      mkdirSync(env.TMPDIR!, { recursive: true });
      writeFileSync(join(hermetic.home, '.gitconfig'), GITCONFIG);
      const brain = new SyntheticBrain(gut, hermetic, env);
      await brain.must(['init', '--pglite', '--non-interactive', '--content-root', brain.contentRoot, '--git']);
      for (const p of pages) await brain.must(['put', p.slug], p.markdown);
      brain.git('add', '-A');
      brain.git('commit', '-qm', 'seed fictional brain');
      await brain.must(['sync']);
      return brain;
    } catch (e) {
      hermetic.restore();
      throw e;
    }
  }

  run(argv: string[], stdin?: string) { return execGbrain(this.gut, this.env, argv, stdin); }

  private async must(argv: string[], stdin?: string) {
    const r = await this.run(argv, stdin);
    if (r.exit !== 0) throw new Error(`gbrain ${argv[0]} failed on the synthetic brain (exit ${r.exit}): ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
    return r;
  }

  git(...args: string[]): string {
    return Bun.spawnSync(['git', '-C', this.contentRoot, ...args], { env: this.env }).stdout.toString().trim();
  }

  pageFile(slug: string): string { return join(this.contentRoot, `${slug}.md`); }

  /** Appends a line to a page's file outside gbrain; commit makes it a committed change gbrain has not imported. */
  editOutside(slug: string, line: string, commit: boolean) {
    appendFileSync(this.pageFile(slug), `\n${line}\n`);
    if (commit) { this.git('add', '--', `${slug}.md`); this.git('commit', '-qm', `edit ${slug} outside gbrain`); }
  }

  async snapshot(): Promise<BrainSnapshot> {
    const dir = mkdtempSync(join(this.env.TMPDIR!, 'export-'));
    rmSync(dir, { recursive: true, force: true });
    try {
      await this.must(['export', '--dir', dir]);
      const pages: Record<string, string> = {};
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (name.endsWith('.md')) pages[relative(dir, p).slice(0, -3)] = readFileSync(p, 'utf8');
        }
      };
      walk(dir);
      const recalled = await this.must(['recall', '--since', '2000-01-01', '--limit', '1000', '--json']);
      const parsed = JSON.parse(recalled.stdout.slice(recalled.stdout.indexOf('{'))) as { facts?: Array<Record<string, unknown>> };
      const facts = (parsed.facts ?? []).map(f => ({ id: String(f.id ?? f.fact_id ?? ''), entity: String(f.entity_slug ?? f.entity ?? ''), fact: String(f.fact ?? f.text ?? '') }));
      return { pages, facts };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  dispose() { this.hermetic.restore(); }
}

/** The CLI arm: one gbrain tool, argv-only exec, no shell. */
export class GbrainCliArm implements Arm {
  readonly name = 'gbrain-cli';
  readonly calls: ArmCall[] = [];
  constructor(private brain: SyntheticBrain) {}
  systemHint() {
    return 'The knowledge base is a gbrain brain reached through the gbrain tool, which runs the gbrain command line with the arguments you pass. Read with get, search, query, recall and list; save with remember and put. A refused call prints Error [<code>] or a JSON error with a fix: read it before you retry.';
  }
  tools() { return [GBRAIN_CLI_TOOL]; }
  writeTools() { return ['gbrain']; }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (name !== 'gbrain') throw new Error(`unknown tool ${name}`);
    const argv = validateArgv(args.argv);
    const stdin = typeof args.stdin === 'string' ? args.stdin : undefined;
    const r = await this.brain.run(argv, stdin);
    const output = capText([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n'));
    this.calls.push({ surface: 'cli', argv, exit: r.exit, output, ms: r.ms });
    return `exit ${r.exit ?? 'killed'}\n${output}`;
  }
}

/** The MCP arm: cat40's McpClient on gbrain serve over stdio, the way a remote agent connects. */
export class GbrainMcpArm implements Arm {
  readonly name = 'gbrain-mcp';
  readonly calls: ArmCall[] = [];
  private constructor(private client: McpClient) {}
  static async start(brain: SyntheticBrain): Promise<GbrainMcpArm> {
    const client = new McpClient({ buildDir: brain.gut.root, env: brain.env }, []);
    await client.start();
    return new GbrainMcpArm(client);
  }
  systemHint() {
    return `The knowledge base is a gbrain brain, reached through the MCP tools listed. The gbrain server's instructions follow.\n<mcp_server_instructions server="gbrain">\n${this.client.instructions}\n</mcp_server_instructions>`;
  }
  tools(): ToolSpec[] {
    return this.client.tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> }));
  }
  toolsVersion() { return this.client.toolsVersion; }
  writeTools() { return this.client.tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name); }
  /** The served tool schemas, for the schema-shape grammar. */
  schemas() { return this.client.tools.map(t => ({ name: t.name, inputSchema: (t.inputSchema ?? {}) as Record<string, unknown> })); }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const t0 = Date.now();
    const output = await this.client.call(name, args);
    this.calls.push({ surface: 'mcp', argv: [name], args, exit: output.startsWith('Error:') ? 1 : 0, output: capText(output), ms: Date.now() - t0 });
    return output;
  }
  close() { return this.client.close(); }
}
