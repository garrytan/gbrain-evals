# Daily retrieval commit screen

`scripts/retrieval-commit-screen.ts` lists every commit in a time window and tags each one `yes`, `maybe` or `no`:
can this commit change what a gbrain benchmark measures? It looks for changes to search results, ranking,
embeddings, chunking, search latency or a storage engine (Postgres, PGLite, Rust). Use it once a day to decide
which engine-bench or retrieval baselines need a rerun.

The script reads only your local git checkout. It makes no GitHub API calls and runs no `git fetch`, so fetch the refs
you want first. In a partial clone (`--filter=blob:none`) git 2.44 or newer does not fetch missing file contents
either; older git can still fetch them on demand. A tag is a pointer for a person to review, not a verdict: read every `yes` and `maybe` row before you
schedule a rerun.

## Run the daily screen

Use a 24-hour window that ends now. Fetch first, then screen each range you care about. One `--range` is one table
in the report; its value is a label, `=`, then any `git rev-list` arguments.

```bash
SINCE="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)"   # macOS: date -u -v-24H +%Y-%m-%dT%H:%M:%SZ

# gbrain: master, plus any branch that is not on master yet
git -C ../gbrain fetch origin master <branch>
bun scripts/retrieval-commit-screen.ts --repo ../gbrain --kind gbrain --since "$SINCE" \
  --range 'master=origin/master' \
  --range '<branch> (not on master)=origin/<branch> ^origin/master' \
  --link https://github.com/garrytan/gbrain \
  --json gbrain-screen.json > gbrain-screen.md

# a pull request head that is on neither ref above
git -C ../gbrain fetch origin 'refs/pull/<n>/head:refs/remotes/origin/pr-<n>'
#   add: --range 'PR <n> head only=origin/pr-<n> ^origin/master ^origin/<branch>'

# gbrain-evals: the benchmark harness itself
git fetch origin main
bun scripts/retrieval-commit-screen.ts --repo . --kind evals --since "$SINCE" \
  --range 'evals main=origin/main' \
  --link https://github.com/garrytan/gbrain-evals > evals-screen.md
```

The Markdown report goes to stdout: one table per range with SHA (linked), committer date in UTC, title, author,
tag and the reason for the tag. `--json` also writes every row, with its changed files, to a file. The script writes
that file first, through a temporary file and a rename, so a failed run leaves no partial file and no report.

When the script cannot run, it prints `retrieval-commit-screen: <CODE>: <what happened>` and a `fix:` line to stderr:

| Code | Exit | Meaning |
|---|---|---|
| `USAGE` | 2 | An option is missing, unknown, repeated (only `--range` repeats), has no value, or has a bad value (`--since` must be an ISO date, `--kind` is `gbrain` or `evals`, `--range` is `label=revs` with a label of its own and no token that starts with `-`). |
| `GIT_FAILED` | 1 | A git command failed, for example `--repo` is not a checkout or a range names a ref you did not fetch. |
| `JSON_WRITE_FAILED` | 1 | The `--json` file could not be written, for example its directory does not exist. |

## How a commit is tagged

1. Each changed file takes the class of the first rule in `RULES` that matches its path:

   | Class | Paths (summary; `RULES` is the source) |
   |---|---|
   | `ignore` | tests, docs, `changelog.d/`, skills, plugin and template trees, any `*.md`, `llms*.txt`, `VERSION`, `.github/`, `.gstack/`, `*.generated.ts`, the error registry, published evals results |
   | `strong` | search and ranking (`src/core/search/`, the search, keyword, vector and graph-rank engine SQL, query expansion, reranking), Rust search code, embedding code, chunkers |
   | `engine` | the Postgres, PGLite and Rust engines, shared engine SQL, `engine*.ts`, statement deadlines, `db.ts`, `migrate.ts`, the schema and migrations, `package.json` and `bun.lock` dependency changes |
   | `context` | inputs that decide what is indexed or visible: trust, access, ops, verbs, facts, persistence, `import-file.ts`, `operations.ts`, config, and the sync, import, embed, query and search commands |
   | `harness` | with `--kind evals` only: retrieval bench runners (including the plain and hybrid baselines, `eval/runner/systems/baselines.ts`, the shared `eval/runner/metrics.ts` scoring and the scorers under `eval/runner/evaluator/`), adapters, loaders and corpora, and the shared harness |

2. An `engine` or `context` file counts as `strong` when a changed, non-comment line matches `RETRIEVAL_LINE`, for
   example `ts_rank`, `tsvector`, `search_vector`, `<=>`, `hnsw`, `embedding`, `rrf`, `rerank`, `bm25`,
   `searchKeyword`, `hybridSearch`, `chunk_text`, `sealChunks` or `boost`. A `harness` file counts as `strong` when
   a changed line matches `HARNESS_LINE`, for example `topK`, `limit:`, `expansion`, `rerank`, `recall_all`,
   `ndcg` or `goldSessions`.
3. The commit tag: any `strong` file gives `yes`. Otherwise any `engine`, `context` or `harness` file gives `maybe`.
   Otherwise a commit that changes code outside the mapped paths and whose subject matches `RETRIEVAL_SUBJECT`
   (search, rank, embed, chunk, vector, latency, query and similar words) gives `maybe`. Everything else is `no`.
4. A `package.json` change that only moves the top-level `"version"` is not a dependency change. The old and new files are
   compared as parsed JSON, so a one-line or reordered file works too. If either side is not valid JSON, the
   changed-line rule decides. A `bun.lock` change always counts
   as one, with or without `package.json`. In gbrain-evals, a change to the `"gbrain"` pin is always `strong`.
5. A merge commit is tagged only on what the merge itself changed against every parent (`git diff-tree --cc`):
   conflict resolutions and edits made in the merge. The commits it brings in get their own rows. The window is by
   committer date, so a merge inside the window can bring in commits dated before it; those are listed right after
   the merge, marked `(via merge <sha>)`, and counted in the range's summary line. Commits reachable from a `^` ref
   in the same `--range` are left out.

6. The script reads file names from NUL-separated git output, so names with quotes, backslashes or non-ASCII letters
   are tagged like any other path. It also pins the git settings it depends on (colour, diff prefixes, rename
   detection, external diff and text conversion drivers, signature display, literal paths, UTC). Your own git
   config and aliases for diff or log do not change a tag.

To change what counts, edit `RULES` or the three patterns at the top of the script; the tests in
`test/eval/retrieval-commit-screen.test.ts` pin the behavior.

## Known gaps

- **Long SQL lines can give a false `yes`.** The line check reads a whole changed line. A schema file can hold one
  very long line, such as a list of function names, and one name on it (for example `update_chunk_search_vector`)
  matches `RETRIEVAL_LINE` although the commit changes no ranking. Review every `yes` that comes only from
  `schema+sql` or `engine:shared sql+sql`. A possible fix is to skip changed lines longer than about 2,000
  characters; it is not built yet.
- **Fast-forwarded or stale-dated commits can be missed.** The window is by committer date, and a fast-forward merge
  has no merge commit. A branch that was committed days ago and fast-forwarded into `master` today keeps its old
  dates, so a daily window never lists it. Screen long-lived branches by their own range (for example
  `<ref> ^<last-screened-ref>`), or widen `--since` when you know such a branch landed.
- **A pure rename counts as a full rewrite.** The script turns rename detection off so every user sees the same
  verdict, so moving an engine file to a new path scans the whole file body and can give a `yes` where nothing
  changed. Check the diff before you act on it.
- **Some file names still fall to `maybe`.** A quoted name that holds a character outside the Basic Multilingual Plane
  (for example an emoji) or a byte that is not valid UTF-8 is read with a lossy name, so its line-level upgrade is
  lost and the commit gets `maybe` instead of `yes`.
- **Repository attributes can hide a diff.** A `binary` or `-diff` attribute (in `.gitattributes` or `.git/info/attributes`)
  on an engine file makes git print "Binary files differ", so no line is scanned and the file is at most `maybe`.
- Range labels are only names. A label such as `__proto__` is accepted and written to the JSON as an ordinary key.
- The line filter treats changed lines that start with `//`, `/*`, `*`, `#` or `--` as comments and ignores them. A real change on
  such a line (for example a `--` SQL line or a `#` shell line) is not read.
- Commit subjects and authors are written into the Markdown table as they are. Markdown or pipe characters in them
  can bend a row.
- The window is by committer date. A commit with a wrong clock, dated earlier than its parent, can stop git from
  walking to commits behind it, so those commits may be missing from a range. Merges bring in older commits as
  described above; other history rewrites do not.
- A single commit that changes thousands of engine files can pass git's command-line length limit. The run then
  stops with `GIT_FAILED` instead of skipping that row.
- Write a range as `<ref> ^<base>`, not `<base>..<ref>`. The "brought in by a merge" listing skips only `^` revisions, so the
  two-dot form lists every older commit a merge of the base brings in, with extra git calls per row.
- Path rules follow today's layout. A new search file outside the mapped paths shows up only as a subject-based
  `maybe`, or as `no` when its subject names no retrieval word.
- The script judges the diff, not the effect. A `yes` can move no number, and a `no` in a config default can.

## Reporting Rust engine latency

Commits that add caches to the Rust engine's search path (for example a search-vector cache or a vector cache) make
the first query and repeat queries behave differently.
Report Rust latency as separate cold-cache and warm-cache p50 and p95 columns, so a cache gain does not hide a
first-query regression. This changes how latency is reported, not any threshold.
