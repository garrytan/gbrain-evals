/**
 * The harness dev lane's models (GST-758, GST-798): new dev cells read with the newest Opus and are judged by gpt-6.1-sol,
 * BEAM keeps the judge its pinned harness fixes, and the scripts that reproduce the October 5 dev phase pin the models
 * that phase ran on instead of taking the new defaults.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { devSpec, type Track } from '../../eval/runner/harness-dev.ts';

const SCRIPTS = join(resolve(import.meta.dir, '../..'), 'eval/harness-provider');
const track = (over: Partial<Track> = {}): Track => ({
  provider: 'gbrain', dataset: 'locomo', split: 'locomo10', units: ['conv-26'], lane: 'raw', mode: 'rag',
  base: {}, extra: {}, targets: [8000], sample: 40, runDefault: false, ...over,
});

describe('harness dev lane models', () => {
  test('a dev cell reads with claude-opus-5-5 and is judged by gpt-6.1-sol, except BEAM, whose harness fixes its judge', () => {
    expect(devSpec(track(), 8000, {}, 10).models).toEqual({ answer: 'anthropic:claude-opus-5-5', judge: 'openai:gpt-6.1-sol' });
    expect(devSpec(track({ dataset: 'beam', split: '100k' }), 8000, {}, 10).models).toEqual({ answer: 'anthropic:claude-opus-5-5', judge: 'gemini:gemini-3.5-flash' });
  });

  test('a track can name its own answer model and judge (--answer, --judge)', () => {
    expect(devSpec(track({ answer: 'openai:gpt-6.1-sol', judge: 'anthropic:claude-opus-5-5' }), 8000, {}, 10).models).toEqual({ answer: 'openai:gpt-6.1-sol', judge: 'anthropic:claude-opus-5-5' });
  });

  test('every script that reproduces the October 5 dev phase pins that phase\'s answer model and judge', () => {
    const scripts = readdirSync(SCRIPTS).filter(f => f.endsWith('.sh') && readFileSync(join(SCRIPTS, f), 'utf8').includes('harness-dev.ts sweep')).sort();
    expect(scripts.length).toBe(8);
    for (const f of scripts) {
      const text = readFileSync(join(SCRIPTS, f), 'utf8');
      expect([f, /^ANSWER=gemini:gemini-3\.8-flash$/m.test(text), /^MODELS="--answer \$ANSWER --judge gemini:gemini-3\.5-flash"$/m.test(text)]).toEqual([f, true, true]);
      const runs = text.split('\n').filter(l => /^\s*D=/.test(l));
      expect([f, runs.length > 0 && runs.every(l => l.includes('harness-dev.ts sweep $MODELS'))]).toEqual([f, true]);
    }
  });
});
