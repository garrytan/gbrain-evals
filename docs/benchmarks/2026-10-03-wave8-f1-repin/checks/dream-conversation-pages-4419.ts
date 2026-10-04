// Fix wave 8 #4419: Dream's synthesize phase reads imported `type: conversation` pages. Keyless: no provider is
// configured, so triage cannot score anything; discovery shows in the phase's verdict list and its warning.
// Exit 0 when every preregistered expectation holds (item D3).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, gbrain, keylessHome } from './lib.ts';

const SLUG = 'example-standup-chat';
const turns = Array.from({ length: 12 }, (_, i) => `**${i % 2 ? 'Bob Demo' : 'Alice Example'}** (2026-09-30 9:${String(10 + i).padStart(2, '0')} AM): Example standup point ${i + 1} about the example launch checklist and the example vendor review.`);
const page = `---\ntype: conversation\ntitle: Example standup chat\ndate: 2026-09-30\n---\n${turns.join('\n')}\n`;
const synth = (r: { stdout: string }) => {
  try { return (JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).phases ?? []).find((p: any) => p.phase === 'synthesize') ?? null; } catch { return null; }
};

async function brain(configure: (env: Record<string, string>, home: string) => Promise<void>) {
  const h = keylessHome();
  await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
  const dir = mkdtempSync(join(tmpdir(), 'w8f1-dream-'));
  writeFileSync(join(dir, `${SLUG}.md`), page);
  await gbrain(['import', dir, '--no-embed'], h.env);
  await gbrain(['config', 'set', 'dream.synthesize.min_chars', '0'], h.env);
  await configure(h.env, h.home);
  const run = await gbrain(['dream', '--phase', 'synthesize', '--dry-run', '--json', '--dir', dir], h.env);
  h.cleanup();
  return { run, phase: synth(run) };
}

// D3a: a corpus directory is set (empty), conversation pages left at their default: the imported page is discovered.
const withCorpus = await brain(async (env, home) => {
  const corpus = join(home, 'empty-corpus'); mkdirSync(corpus);
  await gbrain(['config', 'set', 'dream.synthesize.session_corpus_dir', corpus], env);
  await gbrain(['config', 'set', 'dream.synthesize.enabled', 'true'], env);
});
// D3b: nothing configured: the phase warns with the opt-in command instead of a clean skip.
const unconfigured = await brain(async () => {});

const verdictText = JSON.stringify(withCorpus.phase?.details ?? {});
finish('dream-conversation-pages-4419', {
  D3a_imported_conversation_page_discovered: verdictText.includes(`gbrain-page://default/${SLUG}`),
  D3b_unconfigured_warns_with_opt_in_command: unconfigured.phase?.status === 'warn'
    && JSON.stringify(unconfigured.phase).includes('gbrain config set dream.synthesize.conversation_pages true'),
}, {
  with_corpus: { code: withCorpus.run.code, phase: withCorpus.phase, stderr_tail: withCorpus.run.stderr.slice(-600) },
  unconfigured: { code: unconfigured.run.code, phase: unconfigured.phase, stderr_tail: unconfigured.run.stderr.slice(-600) },
});
