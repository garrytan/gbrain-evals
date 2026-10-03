// Foundations 1 (gbrain c3770114): `gbrain import <dir>` on a directory that the enclosing git repository ignores
// imports its files instead of reporting success with zero files; importing the repository itself still honors .gitignore.
// Exit 0 when every preregistered expectation holds (item B).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, gbrain, keylessHome } from './lib.ts';

const N = 3;
const repo = mkdtempSync(join(tmpdir(), 'w8f1-repo-'));
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
git('init', '-q');
writeFileSync(join(repo, '.gitignore'), 'scratch/\n');
writeFileSync(join(repo, 'tracked-note.md'), '---\ntitle: Tracked note\n---\nA tracked example note about the example garden.\n');
mkdirSync(join(repo, 'scratch'));
for (let i = 1; i <= N; i++) writeFileSync(join(repo, 'scratch', `scratch-note-${i}.md`), `---\ntitle: Scratch note ${i}\n---\nScratch example note ${i} about the example orchard.\n`);
git('add', '.');
git('-c', 'user.email=check@example.invalid', '-c', 'user.name=check', 'commit', '-qm', 'example');

const count = (out: string) => Number(/(\d+) pages imported/.exec(out)?.[1] ?? NaN);
const ignored = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], ignored.env);
const scratch = await gbrain(['import', join(repo, 'scratch'), '--no-embed'], ignored.env);
const listed = await gbrain(['list', '--limit', '50'], ignored.env);

const whole = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], whole.env);
const repoRun = await gbrain(['import', repo, '--no-embed'], whole.env);
const wholeList = await gbrain(['list', '--limit', '50'], whole.env);

finish('import-ignored-dir', {
  B1_ignored_dir_imports_its_files: scratch.code === 0 && count(scratch.stdout) === N,
  B1_pages_listed: [1, 2, 3].every(i => listed.stdout.includes(`scratch-note-${i}`)),
  B2_repo_import_honors_gitignore: repoRun.code === 0 && count(repoRun.stdout) === 1 && wholeList.stdout.includes('tracked-note') && !wholeList.stdout.includes('scratch-note'),
}, {
  scratch_import: { code: scratch.code, stdout: scratch.stdout.slice(-800), stderr: scratch.stderr.slice(-800) },
  scratch_list: listed.stdout.slice(-800),
  repo_import: { code: repoRun.code, stdout: repoRun.stdout.slice(-800) },
  repo_list: wholeList.stdout.slice(-800),
});
