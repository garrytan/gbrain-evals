// Coverage audit pass 2 (ship-workflow): strict-pageless agent.ts entity matching and CLI guards.
// Value: protects=namesEntity matching and main's refusals (flags, item ranges, --model shape, missing key before any write);
//   fails_when=a guard is dropped or loosened, or entity normalisation (.md, spaces, last segment) regresses;
//   why_new=strict-pageless.test.ts covers items, report and analyze only; seam=none;
//   no_claim=real provider runs (all provider keys stripped from the child env; fake agent only)
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { namesEntity } from '../../eval/runner/strict-pageless/agent.ts';
import { itemById } from '../../eval/runner/strict-pageless/items.ts';

const AGENT = resolve(import.meta.dir, '../../eval/runner/strict-pageless/agent.ts');
const GBRAIN = resolve(import.meta.dir, '../../node_modules/gbrain');
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PARTICLE_API_KEY', 'GEMINI_API_KEY', 'VOYAGE_API_KEY'];
const keyless = () => ({ ...process.env, ...Object.fromEntries(KEYS.map(k => [k, ''])) }) as Record<string, string>;
const run = (args: string[], cwd?: string) => spawnSync('bun', ['--no-env-file', AGENT, ...args], { cwd, env: keyless(), encoding: 'utf8', timeout: 110_000 });
const scratch = () => mkdtempSync(join(tmpdir(), 'sp-'));

describe('namesEntity', () => {
  const ivan = itemById(1);
  test.each([
    ['people/ivan-example', true], ['people/ivan-example.md', true], ['People/Ivan_Example', true], ['ivan example', true],
    ['people/jun-example', false], ['ivan/people/jun-example', false], [null, false], [42, false], [undefined, false],
  ] as Array<[unknown, boolean]>)('%p -> %p', (ref, want) => expect(namesEntity(ivan, ref)).toBe(want));
});

describe('strict-pageless agent CLI guards', () => {
  const base = (out: string) => ['--gbrain-root', GBRAIN, '--out', out];
  test('required flags', () => {
    const r = run(['--model', 'fake', '--items', '1']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('are required');
  });
  test('a counted run refuses pilot items and a pilot refuses counted items, before writing', () => {
    const out = join(scratch(), 'o');
    expect(run(['--model', 'fake', '--items', '101', ...base(out)]).stderr).toContain('a counted run takes items 1 to 24 only');
    expect(run(['--model', 'fake', '--items', '1', '--pilot', ...base(out)]).stderr).toContain('a pilot runs items above 100 only');
    expect(existsSync(out)).toBe(false);
  });
  test('--model must be anthropic:<id> or openai:<id> matching the model', () => {
    const out = join(scratch(), 'o');
    for (const m of ['claude-opus-5-5', 'gemini:x', 'openai:claude-opus-5-5']) {
      expect(run(['--model', m, '--items', '1', ...base(out)]).stderr).toContain('--model takes anthropic:<id> or openai:<id>');
    }
    expect(existsSync(out)).toBe(false);
  });
  test('a missing key refuses before any output or ledger write, even with a key in a .env file', () => {
    const dir = scratch(), out = join(dir, 'o'), ledger = join(dir, 'ledger.jsonl');
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=placeholder-not-a-key\n');
    const r = run(['--model', 'anthropic:claude-opus-5-5', '--items', '1', '--gbrain-root', join(dir, 'no-gbrain'), '--out', out, '--budget-ledger', ledger, '--program-cap-usd', '1', '--budget-usd', '1'], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(ledger)).toBe(false);
  });
  test('a rerun skips an item whose file already exists', () => {
    const out = scratch();
    writeFileSync(join(out, 'item-1-r1.json'), '{"kept":true}');
    const r = run(['--model', 'fake', '--items', '1', ...base(out)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('item 1 r1: exists');
    expect(readFileSync(join(out, 'item-1-r1.json'), 'utf8')).toBe('{"kept":true}');
    expect(readdirSync(out)).toEqual(['item-1-r1.json']);
  });
});

describe.skipIf(!existsSync(join(GBRAIN, 'src/core/pglite-engine.ts')))('strict-pageless fake episode', () => {
  test('the keyless scripted agent writes one scored record and cleans its work dir', () => {
    const out = scratch();
    const r = run(['--model', 'fake', '--items', '1', '--gbrain-root', GBRAIN, '--out', out]);
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(out, 'item-1-r1.json'), 'utf8'));
    expect(rec).toMatchObject({ schema: 'strict-pageless-agent/1', model: 'fake', loop_model: 'fake', budget: null, attempts: [] });
    expect(rec.tool_calls.map((c: { name: string }) => c.name)).toEqual(['get_page', 'remember']);
    expect(rec.exposure).toBe(true);
    expect(typeof rec.kept_in_git).toBe('boolean');
    expect(typeof rec.report.truthful).toBe('boolean');
    expect(readdirSync(join(out, 'work'))).toEqual([]);
  }, 120_000);
});
