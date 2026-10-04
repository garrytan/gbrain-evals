#!/usr/bin/env python3
"""Post-hoc attribution helper: copy of the cleaned _s file with every session id replaced by gbrain's opaque id
(s- + first 10 hex of sha256('<question_id>:<slug-normalized id>'), as gbrain >= b80cad6 renders it), in both
haystack_session_ids and answer_session_ids. Turns, dates and questions are unchanged.
Usage: opaque-dataset.py <in.json> <out.json>"""
import hashlib, json, re, sys
def norm(s): return re.sub(r'[^a-z0-9-]', '-', re.sub(r'[_.]', '-', s.lower()))
def opaque(q, s): return 's-' + hashlib.sha256(f'{q}:{norm(s)}'.encode()).hexdigest()[:10]
d = json.load(open(sys.argv[1]))
for q in d:
    qid = q['question_id']
    q['haystack_session_ids'] = [opaque(qid, s) for s in q['haystack_session_ids']]
    q['answer_session_ids'] = [opaque(qid, s) for s in q['answer_session_ids']]
json.dump(d, open(sys.argv[2], 'w'))
print(len(d), sum('answer_' in s for q in d for s in q['haystack_session_ids']))
