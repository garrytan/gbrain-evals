import { describe, expect, test } from 'bun:test';
import { resolveGbrainUnderTest, type GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { ABORT_CODES, LiveRecallAbort, REFERENCE_BUILDS, assertReferenceBuild, checkSchema, openPostgresBrain } from '../../eval/runner/live-recall/brain.ts';

const pinned = resolveGbrainUnderTest(null);
const code = async (fn: () => unknown) => { try { await fn(); return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); } };
const overlay = (version: string, commit: string) => ({ ...pinned, version, overlay: { ...(pinned.overlay ?? {}), build: { commit } } } as unknown as GbrainUnderTest);
const brainAt = (schema: number) => ({ getConfig: async (key: string) => (key === 'version' ? String(schema) : null) });

describe('reference builds on a newer schema', () => {
  test('only the named reference builds, at their exact commits, pass the reference check', async () => {
    expect(REFERENCE_BUILDS).toEqual({ '0.60.682.0': '42faabf28882a9197fcf504c5f8b3c7f6e9d9672', '0.60.613.0': '98dda48fb9fd339609d6d4eef009811280ff648d' });
    expect(await code(() => assertReferenceBuild(overlay('0.60.682.0', '42faabf28882a9197fcf504c5f8b3c7f6e9d9672')))).toBe('no abort');
    expect(await code(() => assertReferenceBuild(overlay('0.60.613.0', '98dda48fb9fd339609d6d4eef009811280ff648d')))).toBe('no abort');
    expect(await code(() => assertReferenceBuild(overlay('0.60.682.0', '98dda48fb9fd339609d6d4eef009811280ff648d')))).toBe('LR_REFERENCE_BUILD');
    expect(await code(() => assertReferenceBuild(overlay('0.60.733.0', '6ce7195b44a034f85aec811f11fbf862db376f50')))).toBe('LR_REFERENCE_BUILD');
    expect(await code(() => assertReferenceBuild(pinned))).toBe('LR_REFERENCE_BUILD');
    expect(ABORT_CODES.LR_REFERENCE_BUILD).toContain('REFERENCE_BUILDS');
  });

  test('a reference build may read a newer schema, never an older one; without the flag the schema must match exactly', async () => {
    const latest = Number((await import(pinned.root + '/src/core/migrate.ts')).LATEST_VERSION);
    expect(await checkSchema(brainAt(latest), pinned)).toEqual({ schema_version: latest, code_schema_version: latest });
    expect(await code(() => checkSchema(brainAt(latest + 13), pinned))).toBe('LR_SCHEMA_MISMATCH');
    expect(await checkSchema(brainAt(latest + 13), pinned, true)).toEqual({ schema_version: latest + 13, code_schema_version: latest });
    expect(await code(() => checkSchema(brainAt(latest - 1), pinned, true))).toBe('LR_SCHEMA_MISMATCH');
  });

  test('openPostgresBrain refuses an unnamed reference build before it reads any database variable', async () => {
    expect(await code(() => openPostgresBrain(pinned, 'LIVE_RECALL_TEST_UNSET', { refusals: {} }, true))).toBe('LR_REFERENCE_BUILD');
    expect(await code(() => openPostgresBrain(pinned, 'LIVE_RECALL_TEST_UNSET', { refusals: {} }))).toBe('LR_NO_DATABASE_URL');
  });
});
