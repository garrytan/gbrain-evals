// Reruns every ledger repro listed in a previous repros file (lines starting with "$ "), each with provider keys
// stripped and a fresh GBRAIN_HOME, and writes the same block format: the command, its output without
// schema-migration lines, and its exit code.
//   bun docs/benchmarks/2026-10-04-operator-wave-repin/run-repros.ts <list.txt> <out.txt> [extra command ...]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [list, out, ...extra] = process.argv.slice(2);
if (!list || !out) throw new Error('usage: run-repros.ts <list.txt> <out.txt> [extra command ...]');
const commands = [...readFileSync(list, 'utf8').split('\n').filter(l => l.startsWith('$ ')).map(l => l.slice(2).trim()), ...extra];
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'GROQ_API_KEY', 'JEV_TYPESAFE_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'];
const MIGRATION = /^\s*(Setting up brain schema|v\d+: |\d+ migration\(s\) applied)/;
const pkg = JSON.parse(readFileSync('node_modules/gbrain/package.json', 'utf8'));
const declared = /#([0-9a-f]{40})/.exec(JSON.parse(readFileSync('package.json', 'utf8')).dependencies.gbrain)?.[1] ?? 'unknown';
const blocks: string[] = [
  `# Ledger repros rerun on ${new Date().toISOString().slice(0, 10)} against the pinned gbrain ${declared} (v${pkg.version}), Bun ${Bun.version}.`,
  '# Each block: the repository-root command (keys stripped, fresh GBRAIN_HOME), its exit code and its output without schema-migration lines.',
];
let failed = 0;
for (const cmd of commands) {
  const home = mkdtempSync(join(tmpdir(), 'repro-home-'));
  const env: Record<string, string> = { ...process.env as Record<string, string>, GBRAIN_HOME: home };
  for (const k of KEYS) delete env[k];
  const proc = Bun.spawnSync(['bash', '-c', `${cmd} 2>&1`], { env, stdout: 'pipe', timeout: 900_000 });
  rmSync(home, { recursive: true, force: true });
  const text = proc.stdout.toString().split('\n').filter(l => !MIGRATION.test(l)).join('\n').trimEnd();
  const code = proc.exitCode ?? 1;
  if (code !== 0) failed++;
  blocks.push(`\n$ ${cmd}\n${text}\nexit ${code}`);
  console.error(`[repros] exit ${code}: ${cmd}`);
}
writeFileSync(out, blocks.join('\n') + '\n');
console.error(`[repros] ${commands.length - failed} of ${commands.length} exit 0 -> ${out}`);
