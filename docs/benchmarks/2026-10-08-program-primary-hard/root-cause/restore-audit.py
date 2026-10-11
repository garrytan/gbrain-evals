"""Which committed results ran gbrain's search without its reranker (restored GbrainSlot, stale Voyage port).

Two independent signals per run directory under docs/benchmarks:
  reranked_cells  cells whose metered gbrain provider calls (`gbrain_internal.byModel`) include a rerank request;
                  a dead Voyage port means the request never reaches the metering proxy, so the count is 0;
  notice_cells    cells whose tool results carry gbrain's `rerank_failed` notice (only gbrain builds that emit
                  the agent-visible `degraded_recall` notice can show it).

  python3 docs/benchmarks/2026-10-08-program-primary-hard/root-cause/restore-audit.py > restore-audit.json
"""
import gzip, json, os, re, subprocess

def rows(path):
    op = gzip.open if path.endswith('.gz') else open
    for line in op(path, 'rt'):
        if line.strip():
            try: yield json.loads(line)
            except json.JSONDecodeError: pass

files = subprocess.run(['git', 'ls-files', 'docs/benchmarks'], capture_output=True, text=True).stdout.split()
dirs = {}
for f in files:
    m = re.search(r'(results|transcripts)\.jsonl(\.gz)?$', f)
    if m: dirs.setdefault(os.path.dirname(f), {})[m.group(1)] = f
out = []
for d, fs in sorted(dirs.items()):
    rec = {'dir': d}
    if 'results' in fs:
        metered = reranked = 0
        for r in rows(fs['results']):
            gi = r.get('gbrain_internal')
            if isinstance(gi, dict) and 'byModel' in gi:
                metered += 1
                reranked += any(re.search('rerank', k, re.I) and v.get('requests', 0) > 0 for k, v in gi['byModel'].items())
        if metered: rec.update(metered_cells=metered, reranked_cells=reranked)
    if 'transcripts' in fs:
        cells = notice = searches = 0
        for r in rows(fs['transcripts']):
            tools = r.get('tools') or []
            cells += 1
            s = [t for t in tools if t.get('name') in ('search', 'query')]
            searches += len(s)
            notice += any('rerank_failed' in (t.get('result') or '') for t in s)
        if searches: rec.update(transcript_cells=cells, searches=searches, notice_cells=notice)
    if len(rec) > 1: out.append(rec)
print(json.dumps(out, indent=1))
