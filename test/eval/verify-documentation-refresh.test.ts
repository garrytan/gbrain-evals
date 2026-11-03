/**
 * scripts/verify-documentation-refresh.py `product_pin_references`: bun.lock and every hub sentence that names the
 * `gbrain` product pin must agree with package.json, and the hubs must name one release. Until 2026-10-31 the verifier
 * checked only the `gbrain-cues` pin, so hubs kept naming older pins through later re-pins (audit item D1).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const PUBLICATION = 'docs/benchmarks/2026-10-06-scoreboard/publication.json';
const RENDER = 'docs/benchmarks/2026-10-06-scoreboard/scoreboard.md';
const HUBS = ['README.md', 'docs/README.md', 'docs/settings.md', 'docs/comparison-systems.md', 'docs/retrieval-lessons.md', 'eval/README.md', 'eval/CONTRIBUTING.md', 'eval/CREDITS.md'];
const tmp = mkdtempSync(join(tmpdir(), 'verify-docs-pin-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function references(root: string, check = 'product_pin_references'): Array<string[]> {
  const code = [
    'import importlib.util, json, sys',
    'from pathlib import Path',
    `spec = importlib.util.spec_from_file_location("verify_docs", ${JSON.stringify(join(ROOT, 'scripts/verify-documentation-refresh.py'))})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `print(json.dumps(m.${check}(Path(sys.argv[1]))))`,
  ].join('\n');
  const r = Bun.spawnSync(['python3', '-c', code, root], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

/** A copy of the files the check reads, with `edit` applied to one of them. */
function copyWith(name: string, file: string, edit: (text: string) => string): string {
  const root = join(tmp, name);
  for (const f of ['package.json', 'bun.lock', PUBLICATION, RENDER, ...HUBS]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(ROOT, f), join(root, f));
  }
  const before = readFileSync(join(root, file), 'utf8');
  const after = edit(before);
  if (after === before) throw new Error(`the edit to ${file} changed nothing`);
  writeFileSync(join(root, file), after);
  return root;
}

const sha = /#([a-f0-9]{40})"/.exec(readFileSync(join(ROOT, 'package.json'), 'utf8').match(/"gbrain": "[^"]+"/)![0])![1];

describe('verify-documentation-refresh: the product pin', () => {
  test('the repository passes', () => {
    expect(references(ROOT)).toEqual([]);
  });

  test('a hub that still names an older commit fails, naming the file', () => {
    const root = copyWith('stale-hub', 'eval/README.md', t => t.replace(`master \`${sha.slice(0, 9)}\``, 'master `77cf8e111`'));
    const errors = references(root);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('eval/README.md');
    expect(errors[0][2]).toBe('Product pin reference differs from package.json pin');
  });

  test('the docs index opening is a hub too', () => {
    const root = copyWith('stale-index', 'docs/README.md', t => t.replace(`master \`${sha.slice(0, 9)}\``, 'master `7a6bdd357`'));
    expect(references(root).map(e => [e[0], e[2]])).toEqual([['docs/README.md', 'Product pin reference differs from package.json pin']]);
  });

  test('the credits page names the pin too', () => {
    const root = copyWith('stale-credits', 'eval/CREDITS.md', t => t.replace(`master \`${sha.slice(0, 9)}\``, 'master `7a6bdd357`'));
    expect(references(root).map(e => [e[0], e[2]])).toEqual([['eval/CREDITS.md', 'Product pin reference differs from package.json pin']]);
  });

  test('a hub sentence reworded out of recognition fails as missing, not as passing', () => {
    const root = copyWith('missing-sentence', 'docs/settings.md', t => t.replace('This page describes the gbrain this repository installs', 'This page describes gbrain'));
    expect(references(root).map(e => [e[0], e[1].split(':')[0]])).toEqual([['docs/settings.md', 'Product pin sentence missing']]);
  });

  test('hubs naming the right commit but different releases fail', () => {
    const root = copyWith('two-releases', 'eval/CONTRIBUTING.md', t => t.replace(/(master `[a-f0-9]+` \(v)[\d.]+/, '$10.60.1.0'));
    const errors = references(root);
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toMatch(/^Product pin sentences name different releases: 0\.60\.1\.0, /);
  });

  test('a README link to another commit fails even when the short id matches', () => {
    const root = copyWith('wrong-link', 'README.md', t => t.replace(`gbrain/tree/${sha}`, `gbrain/tree/${sha.slice(0, 9)}${'0'.repeat(31)}`));
    expect(references(root).map(e => e[0])).toEqual(['README.md']);
  });

  test('hubs that name a release the installed gbrain is not fail', () => {
    const root = copyWith('installed-release', 'bun.lock', t => `${t}\n`);
    mkdirSync(join(root, 'node_modules/gbrain'), { recursive: true });
    writeFileSync(join(root, 'node_modules/gbrain/package.json'), JSON.stringify({ name: 'gbrain', version: '0.60.1.0' }));
    const errors = references(root);
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toBe('Product pin sentences name a release other than the installed gbrain v0.60.1.0 (run bun install if package.json moved)');
  });

  test('a product pin that is not an exact commit fails before any hub is read', () => {
    const root = copyWith('branch-pin', 'package.json', t => t.replace(`gbrain#${sha}`, 'gbrain#master'));
    expect(references(root)).toEqual([['package.json', 'Product pin must have an exact 40-character Git pin']]);
  });

  test('a lockfile that resolves another commit fails', () => {
    const root = copyWith('stale-lock', 'bun.lock', t => t.replace(`"gbrain": "github:garrytan/gbrain#${sha}"`, `"gbrain": "github:garrytan/gbrain#${'0'.repeat(40)}"`));
    expect(references(root)).toEqual([['bun.lock', 'Declared product pin differs from package.json pin']]);
  });
});

describe('verify-documentation-refresh: the scoreboard explanation', () => {
  test('the repository passes', () => {
    expect(references(ROOT, 'scoreboard_publication_reference')).toEqual([]);
  });

  test('a new publication fails until README\'s paragraph above the block names it', () => {
    const published = JSON.parse(readFileSync(join(ROOT, PUBLICATION), 'utf8')).published.commit as string;
    const root = copyWith('new-publication', PUBLICATION, t => t.replace(published, '0'.repeat(40)));
    const errors = references(root, 'scoreboard_publication_reference');
    expect(errors).toHaveLength(1);
    expect(errors[0].slice(0, 2)).toEqual(['README.md', published]);
    expect(errors[0][2]).toStartWith('The paragraph above the scoreboard block describes a publication other than');
  });

  test('a README paragraph that names no publication commit fails', () => {
    const root = copyWith('no-commit-named', 'README.md', t => t.replace(/check --commit\s+[a-f0-9]{40}/, 'check'));
    expect(references(root, 'scoreboard_publication_reference')).toEqual([['README.md', 'The paragraph above the scoreboard block names no publication commit']]);
  });

  test('a publication that records no commit yet has nothing to compare', () => {
    const published = JSON.parse(readFileSync(join(ROOT, PUBLICATION), 'utf8')).published.commit as string;
    const root = copyWith('pending-publication', PUBLICATION, t => t.replace(`"${published}"`, 'null'));
    expect(references(root, 'scoreboard_publication_reference')).toEqual([]);
  });

  test('a figure in README\'s paragraph that the published render does not show fails, naming the figure', () => {
    const render = readFileSync(join(ROOT, 'README.md'), 'utf8') + readFileSync(join(ROOT, RENDER), 'utf8');
    expect(render).not.toContain('13.85');
    const root = copyWith('stale-figure', 'README.md', t => t.replace('the 13.58 points in the opening sentence', 'the 13.85 points in the opening sentence'));
    expect(references(root, 'scoreboard_publication_reference')).toEqual([
      ['README.md', '13.85', 'The paragraph above the scoreboard block quotes a figure that neither the block nor ' + RENDER + ' shows; update it with the new render'],
    ]);
  });

  test('a figure that ends a sentence in README\'s paragraph is checked too', () => {
    const root = copyWith('stale-figure-at-end', 'README.md', t => t.replace('the 13.58 points in the opening sentence is the preregistered power check for the\ncomponent rows.', 'the opening sentence\'s power check for the component rows detects 13.85.'));
    expect(references(root, 'scoreboard_publication_reference')).toEqual([
      ['README.md', '13.85', 'The paragraph above the scoreboard block quotes a figure that neither the block nor ' + RENDER + ' shows; update it with the new render'],
    ]);
  });

  test('a README with no scoreboard block fails, even when a later section names the publication commit', () => {
    const published = JSON.parse(readFileSync(join(ROOT, PUBLICATION), 'utf8')).published.commit as string;
    const root = copyWith('no-begin-marker', 'README.md', t => `${t.replace('<!-- scoreboard:headline:begin -->\n', '')}\nVerified with \`bun eval/runner/scoreboard.ts check --commit ${published}\`.\n`);
    expect(references(root, 'scoreboard_publication_reference')).toEqual([['README.md', 'README.md has no <!-- scoreboard:headline:begin --> line, so the paragraph above the scoreboard block cannot be found']]);
  });

  test('every commit the paragraph names must be the publication\'s, not only the first', () => {
    const published = JSON.parse(readFileSync(join(ROOT, PUBLICATION), 'utf8')).published.commit as string;
    const stale = '0'.repeat(40);
    const root = copyWith('second-commit', 'README.md', t => t.replace(/(check --commit\s+[a-f0-9]{40}`\))/, `$1 (it replaced \`check --commit ${stale}\`)`));
    const errors = references(root, 'scoreboard_publication_reference');
    expect(errors).toHaveLength(1);
    expect(errors[0].slice(0, 2)).toEqual(['README.md', stale]);
    expect(errors[0][2]).toContain(`records (${published})`);
  });

  test('a publication.json whose published value is not an object fails instead of crashing the verifier', () => {
    const published = JSON.parse(readFileSync(join(ROOT, PUBLICATION), 'utf8')).published.commit as string;
    for (const [name, value] of [['published-string', JSON.stringify(published)], ['published-list', `[${JSON.stringify(published)}]`]]) {
      const root = copyWith(name, PUBLICATION, t => t.replace(/"published": \{[^}]*\}/, `"published": ${value}`));
      expect(references(root, 'scoreboard_publication_reference')).toEqual([[PUBLICATION, 'published is not an object, so the publication commit cannot be read']]);
    }
  });

  test('a publication commit that is missing or not text fails instead of passing or crashing the verifier', () => {
    const published = JSON.parse(readFileSync(join(ROOT, PUBLICATION), 'utf8')).published.commit as string;
    const number = copyWith('commit-number', PUBLICATION, t => t.replace(`"commit": "${published}"`, '"commit": 123'));
    expect(references(number, 'scoreboard_publication_reference')).toEqual([[PUBLICATION, 'published.commit is 123, not a commit or null']]);
    const missing = copyWith('commit-missing', PUBLICATION, t => t.replace(`"commit": "${published}",`, ''));
    expect(references(missing, 'scoreboard_publication_reference')).toEqual([[PUBLICATION, 'published has no commit; a publication pending its commit records null']]);
  });

  test('a commit with characters after its 40, or a short one, is not the publication\'s', () => {
    const published = JSON.parse(readFileSync(join(ROOT, PUBLICATION), 'utf8')).published.commit as string;
    const longer = copyWith('commit-overlong', 'README.md', t => t.replace(/(check --commit\s+[a-f0-9]{40})/, '$1ab'));
    expect(references(longer, 'scoreboard_publication_reference').map(e => e.slice(0, 2))).toEqual([['README.md', `${published}ab`]]);
    const short = copyWith('commit-short', 'README.md', t => t.replace(/(check --commit\s+[a-f0-9]{40}`\))/, '$1 (it replaced `check --commit abc1234`)'));
    expect(references(short, 'scoreboard_publication_reference').map(e => e.slice(0, 2))).toEqual([['README.md', 'abc1234']]);
  });

  test('a figure in another paragraph above the block is checked too', () => {
    const root = copyWith('stale-figure-next-paragraph', 'README.md', t => t.replace('rendered again in custody. Two\nnumbers', 'rendered again in custody.\n\nTwo numbers').replace('the 13.58 points in the opening sentence', 'the 13.85 points in the opening sentence'));
    expect(references(root, 'scoreboard_publication_reference')).toEqual([
      ['README.md', '13.85', 'The paragraph above the scoreboard block quotes a figure that neither the block nor ' + RENDER + ' shows; update it with the new render'],
    ]);
  });

  test('a README whose scoreboard block has no end marker fails instead of reading the rest of README as the render', () => {
    const root = copyWith('no-end-marker', 'README.md', t => t.replace('<!-- scoreboard:headline:end -->\n', ''));
    expect(references(root, 'scoreboard_publication_reference')).toEqual([['README.md', 'README.md has no <!-- scoreboard:headline:end --> line, so the scoreboard block cannot be told from the rest of README']]);
  });
});
