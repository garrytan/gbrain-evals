import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROVIDER_KEYS } from '../support/no-provider-keys.ts';

const gbrain = join(dirname(Bun.resolveSync('gbrain', import.meta.dir)), '..', '..');
const { CONFIG_API_KEY_ENV } = await import(join(gbrain, 'src/core/ai/provider-env.ts'));
const { listRecipes } = await import(join(gbrain, 'src/core/ai/recipes/index.ts'));

/** Recipe auth env names that configure a provider rather than authenticate to it. */
const SETTING = /_(BASE_URL|ENDPOINT|DEPLOYMENT|API_VERSION|USE_ENTRA|ORG_ID|PROJECT|REFERER|TITLE|GROUP_ID)$/;
/** *_API_KEY strings gbrain quotes that name no variable it reads. */
const NOT_VARIABLES: Record<string, string> = { NO_ANTHROPIC_API_KEY: 'an error code (src/core/verbs.ts, src/core/think/index.ts)' };

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
const quoted = new Set(sources(join(gbrain, 'src')).flatMap(f => [...readFileSync(f, 'utf8').matchAll(/['"]([A-Z][A-Z0-9_]*_API_KEY)['"]|env\??\.([A-Z][A-Z0-9_]*_API_KEY)\b/g)].map(m => m[1] ?? m[2])));
const recipeEnv = (listRecipes() as Array<{ auth_env?: { required?: string[]; optional?: string[] } }>).flatMap(r => [...(r.auth_env?.required ?? []), ...(r.auth_env?.optional ?? [])]);
const read = [...new Set([
  ...(CONFIG_API_KEY_ENV as ReadonlyArray<readonly [string, string]>).map(([, name]) => name),
  ...recipeEnv.filter(name => !SETTING.test(name)),
  ...[...quoted].filter(name => !(name in NOT_VARIABLES)),
])].sort();

// Value: protects=no test reaches a real provider through a key gbrain reads and the preload leaves set; fails_when=gbrain's config plane, a gateway recipe or any quoted *_API_KEY in gbrain's source names a key PROVIDER_KEYS does not blank (test/eval/no-provider-keys.test.ts checks that a fresh test process, and its children, see none of PROVIDER_KEYS); why_new=GBEV-3's GST-2010 item for the BG1 preregistration (2026-11-09), after the preload blanked five of gbrain's keys and left OPENROUTER_API_KEY; seam=none; no_claim=credentials gbrain passes through without naming them (a CLI's own login, ANTHROPIC_AUTH_TOKEN)
test('the preload key list covers every provider key gbrain reads at the pin', () => {
  expect(read).toContain('OPENROUTER_API_KEY');
  expect(read).toContain('GROQ_API_KEY');
  expect(read.filter(name => !PROVIDER_KEYS.includes(name))).toEqual([]);
});
