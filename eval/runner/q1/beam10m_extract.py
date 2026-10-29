"""Split BEAM-10M parquet shards into per-conversation corpus and question files.

Custodian only; run by `bun eval/runner/q1/beam10m-manifest.ts fetch` on the
custody host with a pinned pyarrow:

    uv run --no-project --python 3.12 --with pyarrow==21.0.0 \
      python eval/runner/q1/beam10m_extract.py --out <root>/beam-10m/9b20961 <shard.parquet>...

For every row it writes `<out>/10m-<conversation_id>/chat.json` holding only
the `chat` column, and, in a separate pass, `questions.json` holding only the
`probing_questions` column parsed into an object (the hub stores it as a
string; JSON first, then a Python literal, as the public harness parses it).
The two files never share bytes, so corpus loaders can read the first
without the second. Output JSON is compact UTF-8 with keys in source order, so
the same shards and pyarrow version give the same bytes. It prints counts and
ids only, never dataset text.
"""
import argparse
import ast
import json
import os
import sys

import pyarrow.parquet as pq


def rows(shards, columns):
    index = 0
    for shard in shards:
        pf = pq.ParquetFile(shard)
        present = [c for c in columns if c in pf.schema_arrow.names]
        for batch in pf.iter_batches(batch_size=1, columns=present):
            for row in batch.to_pylist():
                index += 1
                cid = row.get('conversation_id')
                yield (str(cid) if cid is not None else str(index)), ('column' if cid is not None else 'row-order'), row


def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False, separators=(',', ':')))


def parse_questions(raw):
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw)
    except Exception:
        value = ast.literal_eval(raw)
    if not isinstance(value, dict):
        raise ValueError('probing_questions is not an object')
    return value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('shards', nargs='+')
    a = ap.parse_args()
    seen = []
    for cid, source, row in rows(a.shards, ['conversation_id', 'chat']):
        if row.get('chat') is None:
            sys.exit(f'row {cid} has no chat column')
        write(os.path.join(a.out, f'10m-{cid}', 'chat.json'), {'conversation_id': cid, 'chat': row['chat']})
        seen.append({'conversation': f'10m-{cid}', 'hf_conversation_id': cid, 'conversation_id_source': source})
    order = []
    for cid, _source, row in rows(a.shards, ['conversation_id', 'probing_questions']):
        write(os.path.join(a.out, f'10m-{cid}', 'questions.json'), {'conversation_id': cid, 'probing_questions': parse_questions(row.get('probing_questions') or '{}')})
        order.append(cid)
    if order != [s['hf_conversation_id'] for s in seen]:
        sys.exit('the two passes saw conversations in a different order')
    print(json.dumps({'rows': len(seen), 'conversations': seen}))


if __name__ == '__main__':
    main()
