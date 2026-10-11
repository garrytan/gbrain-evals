import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATASET_COMMIT, HOST_REF, hostUrl, submoduleUrl } from '../../eval/runner/coding-spike.ts';

const REPO = join(import.meta.dir, '../..');

describe('coding spike launcher', () => {
  test('reads the dataset repository from the harness .gitmodules', () => {
    const gitmodules = '[submodule "sdebench/datasets"]\n\tpath = sdebench/datasets\n\turl = https://github.com/example-org/sde-bench.git\n';
    expect(submoduleUrl(gitmodules)).toBe('https://github.com/example-org/sde-bench.git');
    expect(() => submoduleUrl('[submodule "x"]\n\tpath = x\n\turl = https://example.com/x.git\n')).toThrow(/no sdebench\/datasets/);
  });

  test('derives the host fork next to the dataset repository', () => {
    expect(hostUrl('https://github.com/example-org/sde-bench.git')).toBe('https://github.com/example-org/boltons');
    expect(hostUrl('https://github.com/example-org/sde-bench')).toBe('https://github.com/example-org/boltons');
  });

  test('pins are full commit hashes', () => {
    expect(DATASET_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(HOST_REF).toMatch(/^[0-9a-f]{40}$/);
  });

  test('the agent image routes Gemini through a build-time base URL and loads no plugin', () => {
    const dockerfile = readFileSync(join(REPO, 'eval/harness-provider/coding-spike/Dockerfile.agent'), 'utf8');
    expect(dockerfile).toContain('"plugin":[]');
    expect(dockerfile).toContain('"baseURL":"%s"');
    expect(dockerfile).toContain('ARG GEMINI_BASE_URL');
  });
});
