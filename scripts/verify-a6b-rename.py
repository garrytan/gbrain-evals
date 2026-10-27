#!/usr/bin/env python3
"""Amendment A6b of the open-source memory comparison changed labels, prose and paths, never a number.

Checks, against the commit A6b started from (`base_commit` in the manifest):

1. Every file in docs/benchmarks/2026-10-06-oss-memory-shootout/rename-a6b.json hashes to its recorded `sha256_before`
   at the base commit and to its `sha256_after` in the worktree.
2. Every JSON, NDJSON and gzipped NDJSON file under docs/benchmarks/2026-10-06-oss-memory-shootout*/ that existed at the
   base commit has the same shape and the same numbers, booleans and nulls, in the same places, before and after. Only
   strings and object keys may differ. This covers the sealed aggregates and every receipt.

Run it at the commit that applied A6b; a later commit that edits these files is a new change with its own record.

Usage, from the repository root (needs the base commit in the local history):
  python3 scripts/verify-a6b-rename.py            # verify
  python3 scripts/verify-a6b-rename.py --write    # rewrite the manifest from the worktree (A6b authoring only)
"""
import gzip
import hashlib
import json
import subprocess
import sys

MANIFEST = 'docs/benchmarks/2026-10-06-oss-memory-shootout/rename-a6b.json'
DATA_GLOB = 'docs/benchmarks/2026-10-06-oss-memory-shootout*'
NOT_RENAMED = {MANIFEST, 'scripts/verify-a6b-rename.py', 'VERSION', 'package.json', 'CHANGELOG.md'}
BASE_COMMIT = 'aeabaf7fb4149f1c76a8c31025a95e509cd8e26b'


def git(*args, binary=False):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=not binary).stdout


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def at_base(base, path):
    try:
        return git('show', f'{base}:{path}', binary=True)
    except subprocess.CalledProcessError:
        return None


def records(path, data):
    text = gzip.decompress(data).decode() if path.endswith('.gz') else data.decode()
    if path.endswith('.json'):
        return [json.loads(text)]
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def fixed_leaves(value, where=()):
    if isinstance(value, dict):
        yield where, 'dict', len(value)
        for i, child in enumerate(value.values()):
            yield from fixed_leaves(child, where + (i,))
    elif isinstance(value, list):
        yield where, 'list', len(value)
        for i, child in enumerate(value):
            yield from fixed_leaves(child, where + (i,))
    elif isinstance(value, str):
        yield where, 'str', None
    else:
        yield where, type(value).__name__, value


def write(base):
    changed = [p for p in git('diff', '--name-only', base).split() if p not in NOT_RENAMED]
    files = []
    for path in sorted(changed):
        before = at_base(base, path)
        with open(path, 'rb') as f:
            after = f.read()
        files.append({'path': path, 'sha256_before': sha256(before) if before is not None else None, 'sha256_after': sha256(after)})
    manifest = {
        'amendment': 'A6b',
        'date': '2026-10-08',
        'what': 'Labels, prose and paths only. Product names, versions, licenses and upstream links moved to the one table in '
                'docs/comparison-systems.md#systems-in-the-open-source-comparison; numbers did not change.',
        'base_commit': base,
        'verify': 'python3 scripts/verify-a6b-rename.py',
        'files': files,
    }
    with open(MANIFEST, 'w') as f:
        f.write(json.dumps(manifest, indent=2) + '\n')
    print(f'wrote {MANIFEST}: {len(files)} files')


def verify(base):
    with open(MANIFEST) as f:
        manifest = json.load(f)
    if manifest['base_commit'] != base:
        sys.exit(f'manifest base_commit {manifest["base_commit"]} != {base}')
    problems = []
    for entry in manifest['files']:
        before = at_base(base, entry['path'])
        if (sha256(before) if before is not None else None) != entry['sha256_before']:
            problems.append(f'{entry["path"]}: base content does not hash to sha256_before')
        try:
            with open(entry['path'], 'rb') as f:
                after = sha256(f.read())
        except FileNotFoundError:
            after = None
        if after != entry['sha256_after']:
            problems.append(f'{entry["path"]}: worktree does not hash to sha256_after')
    data_files = [p for p in git('ls-files', DATA_GLOB).split() if p.endswith(('.json', '.ndjson', '.ndjson.gz'))]
    compared = leaves = changed = 0
    for path in data_files:
        before = at_base(base, path)
        if before is None:
            continue
        with open(path, 'rb') as f:
            after = f.read()
        compared += 1
        if before == after:
            continue
        changed += 1
        old, new = records(path, before), records(path, after)
        if len(old) != len(new):
            problems.append(f'{path}: {len(old)} records before, {len(new)} after')
            continue
        for a, b in zip(old, new):
            la, lb = list(fixed_leaves(a)), list(fixed_leaves(b))
            leaves += sum(1 for _, kind, _ in la if kind not in ('dict', 'list', 'str'))
            if la != lb:
                first = next((x, y) for x, y in zip(la + [None], lb + [None]) if x != y)
                problems.append(f'{path}: shape or a number differs at {first}')
                break
    if problems:
        print('\n'.join(problems))
        sys.exit(f'{len(problems)} problem(s)')
    print(f'ok: {len(manifest["files"])} manifest hashes match; {compared} data files compared, {changed} changed, '
          f'{leaves} numbers, booleans and nulls identical in the changed files')


if __name__ == '__main__':
    base = BASE_COMMIT
    write(base) if '--write' in sys.argv[1:] else verify(base)
