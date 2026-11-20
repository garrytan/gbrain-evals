import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../../eval/redis-agent-memory-benchmark/src/agent_memory_benchmark/cli.py');

const HARNESS = String.raw`
import importlib.util, sys, types

def stub(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module

def request_path(*args, **kwargs):
    raise SystemExit("REQUEST_PATH_REACHED")

stub("dotenv", load_dotenv=lambda *a, **k: None)
stub("agent_memory_benchmark")
stub("agent_memory_benchmark.benchmark")
stub("agent_memory_benchmark.benchmark.judge", DEFAULT_JUDGE_MODEL="gpt-4o", judge_experiment=request_path)
stub("agent_memory_benchmark.benchmark.runner", parse_provider_params=lambda params: {}, run_longmemeval_v1=request_path)
stub("agent_memory_benchmark.memory", STORES={"fake": object})
spec = importlib.util.spec_from_file_location("vendored_cli", sys.argv[1])
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
cli.main(sys.argv[2:])
`;

function runCli(args: string[], baseUrl?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  if (baseUrl !== undefined) env.OPENAI_BASE_URL = baseUrl;
  const r = Bun.spawnSync(['python3', '-c', HARNESS, CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const JUDGE = ['judge', '--experiment', 'x'];
const RUN = ['run', '--provider', 'fake'];

describe('vendored Redis harness CLI refuses non-loopback provider routes', () => {
  for (const [name, args, baseUrl] of [
    ['judge with OPENAI_BASE_URL unset', JUDGE, undefined],
    ['judge pointed at api.openai.com', JUDGE, 'https://api.openai.com/v1'],
    ['judge with a loopback env but a remote --base-url', [...JUDGE, '--base-url', 'https://api.openai.com/v1'], 'http://127.0.0.1:8787/v1'],
    ['run with OPENAI_BASE_URL unset', RUN, undefined],
    ['run pointed at a remote host', RUN, 'https://proxy.example.com/v1'],
  ] as const) {
    test(`${name} refuses before any request`, () => {
      const r = runCli([...args], baseUrl);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('refusing to start');
      expect(r.out).not.toContain('REQUEST_PATH_REACHED');
    });
  }

  for (const [name, args, baseUrl] of [
    ['judge through 127.0.0.1', JUDGE, 'http://127.0.0.1:8787/v1'],
    ['judge through ::1', JUDGE, 'http://[::1]:8787/v1'],
    ['run through localhost', RUN, 'http://localhost:8787/v1'],
  ] as const) {
    test(`${name} reaches the request path`, () => {
      const r = runCli([...args], baseUrl);
      expect(r.out).toContain('REQUEST_PATH_REACHED');
      expect(r.out).not.toContain('refusing to start');
    });
  }
});
