#!/usr/bin/env python3
"""Overlap audit: sealed confirmation set vs LongMemEval S/M and existing gbrain-evals data.

Checks, all computed from the private sealed files and the public datasets:
  1. Question overlap: exact normalized matches and word-set Jaccard between every
     sealed question and every LongMemEval S and M question; also whether M's
     questions are the same as S's.
  2. Persona overlap: whether any sealed persona's full name, given name or
     surname, or any capitalized invented name from the persona facts, appears in
     LongMemEval S/M text, and whether persona names appear in eval/data.
  3. Text overlap: 13-word shingles shared between sealed sessions and any
     LongMemEval S/M session (13-grams are the usual contamination unit).
  4. Cat13 overlap: word-set Jaccard between sealed questions and the committed
     Cat13 query subset, plus mentions of the 30 world-v1 concept names Cat13 probes.

The public output holds counts only. The private output lists the matches so
the author can inspect them; it stays with the sealed files.

Usage (repository root):
  uv run --with ijson python3 scripts/sealed-confirmation-overlap.py \
    --questions ~/.capy/work/sealed/v1/questions.json --ledger ~/.capy/work/sealed/v1/ledger.json \
    --lme-s ~/datasets/longmemeval/longmemeval_s_cleaned.json --lme-m ~/datasets/longmemeval/longmemeval_m_cleaned.json \
    --out-public eval/data/sealed-confirmation-v1/overlap-audit.json --out-private ~/.capy/work/sealed/v1/overlap-private.json
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

WORD = re.compile(r"[a-z0-9']+")
SHINGLE = 13
STOP = set("a an the i my me we our you your to of in on at for with and or but is was were be been it this that what which who when where how did do does have has had from by about as than then so".split())
COMMON_CAPS = set("""January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday
I I'm I've I'd I'll The A An My We Our It It's This That What When Where How Why Can Could Would Should Also But And Or If So Then Thanks Thank Yes No Ok Okay""".split())


def words(text):
    return WORD.findall(text.lower())


def content_set(text):
    return {w for w in words(text) if w not in STOP}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def shingles(tokens):
    if len(tokens) < SHINGLE:
        return set()
    return {hashlib.blake2b(" ".join(tokens[i:i + SHINGLE]).encode(), digest_size=8).digest() for i in range(len(tokens) - SHINGLE + 1)}


def session_text(turns):
    return "\n".join(t.get("content", "") for t in turns if isinstance(t, dict))


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def iter_lme(path):
    """Yield LongMemEval rows; stream with ijson when available (M is 2.7 GB)."""
    try:
        import ijson  # type: ignore
        with open(path, "rb") as f:
            yield from ijson.items(f, "item", use_float=True)
    except ImportError:
        print(f"ijson not installed; loading {path} in memory", file=sys.stderr)
        with open(path) as f:
            yield from json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", required=True)
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--lme-s", required=True)
    ap.add_argument("--lme-m", required=True)
    ap.add_argument("--eval-data", default="eval/data")
    ap.add_argument("--cat13-subset", default="eval/data/gold/brainbench-cat13-embedder-subset.json")
    ap.add_argument("--out-public", required=True)
    ap.add_argument("--out-private", required=True)
    a = ap.parse_args()

    questions = json.load(open(a.questions))
    ledger = json.load(open(a.ledger))
    sealed_q = [(q["question_id"], q["question"]) for q in questions["questions"]]
    sealed_q_sets = [(qid, content_set(t)) for qid, t in sealed_q]
    norm = lambda t: " ".join(words(t))
    sealed_norm = {norm(t): qid for qid, t in sealed_q}

    personas = [p for p in ledger["personas"] if p.get("plan")]
    included = {int(k[1:]) for k in ledger["id_map"] if re.fullmatch(r"p\d+", k)}
    personas = [p for p in personas if p["seed"]["persona_index"] in included]
    names = []
    proper = set()
    for p in personas:
        full = p["plan"]["persona"]["name"].strip()
        parts = words(full)
        names.append({"persona": p["seed"]["persona_index"], "full": full.lower(), "given": parts[0] if parts else "", "surname": parts[-1] if len(parts) > 1 else ""})
        for f in p["plan"]["facts"]:
            toks = re.findall(r"[A-Za-z][A-Za-z'-]+", f["statement"])
            for i, t in enumerate(toks):
                if i > 0 and t[0].isupper() and len(t) >= 4 and t not in COMMON_CAPS:
                    proper.add(t.lower())
    name_tokens = {n["given"] for n in names} | {n["surname"] for n in names}

    sealed_shingles = {}
    for h in questions["haystacks"]:
        for s in h["sessions"]:
            for sh in shingles(words(session_text(s["turns"]))):
                sealed_shingles.setdefault(sh, set()).add(s["session_id"])
    print(f"sealed: {len(sealed_q)} questions, {len(names)} personas, {len(proper)} proper nouns, {len(sealed_shingles)} shingles", file=sys.stderr)

    public = {"generated_at": time.strftime("%Y-%m-%d"), "sealed_questions": len(sealed_q), "sealed_personas": len(names), "shingle_words": SHINGLE, "datasets": {}}
    private = {"datasets": {}}
    s_questions = {}
    for label, path in (("longmemeval_s_cleaned", a.lme_s), ("longmemeval_m_cleaned", a.lme_m)):
        t0 = time.time()
        seen_sessions = set()
        exact, best = [], {}
        name_hits, full_name_hits, proper_hits = {}, {}, {}
        shared_sessions = {}
        lme_questions = {}
        n_rows = 0
        for row in iter_lme(path):
            n_rows += 1
            qtext = row["question"]
            lme_questions[row["question_id"]] = qtext
            qn = norm(qtext)
            if qn in sealed_norm:
                exact.append({"sealed": sealed_norm[qn], "lme": row["question_id"]})
            qs = content_set(qtext)
            for qid, ss in sealed_q_sets:
                j = jaccard(ss, qs)
                if j > best.get(qid, (0, None))[0]:
                    best[qid] = (j, row["question_id"])
            for sid, turns in zip(row.get("haystack_session_ids", []), row.get("haystack_sessions", [])):
                if sid in seen_sessions:
                    continue
                seen_sessions.add(sid)
                text = session_text(turns)
                toks = words(text)
                tokset = set(toks)
                for t in name_tokens & tokset:
                    name_hits[t] = name_hits.get(t, 0) + 1
                low = text.lower()
                for n in names:
                    if n["given"] in tokset and n["surname"] in tokset and n["full"] in low:
                        full_name_hits[n["full"]] = full_name_hits.get(n["full"], 0) + 1
                for t in proper & tokset:
                    proper_hits[t] = proper_hits.get(t, 0) + 1
                for sh in shingles(toks) & sealed_shingles.keys():
                    for sealed_sid in sealed_shingles[sh]:
                        shared_sessions.setdefault(sealed_sid, set()).add(sid)
        jac = sorted(v[0] for v in best.values())
        public["datasets"][label] = {
            "file_sha256": file_sha256(path),
            "rows": n_rows,
            "unique_sessions_scanned": len(seen_sessions),
            "exact_question_matches": len(exact),
            "max_question_jaccard": round(jac[-1], 4) if jac else 0,
            "questions_with_jaccard_ge_0_5": sum(1 for v in jac if v >= 0.5),
            "questions_with_jaccard_ge_0_3": sum(1 for v in jac if v >= 0.3),
            "persona_full_name_matches": len(full_name_hits),
            "persona_name_tokens_found": len(name_hits),
            "persona_name_tokens_total": len(name_tokens),
            "invented_proper_nouns_found": len(proper_hits),
            "invented_proper_nouns_total": len(proper),
            "sealed_sessions_sharing_a_13_word_shingle": len(shared_sessions),
            "seconds": round(time.time() - t0, 1),
        }
        private["datasets"][label] = {
            "exact": exact,
            "top_jaccard": sorted(({"sealed": k, "jaccard": round(v[0], 4), "lme": v[1], "sealed_text": dict(sealed_q)[k], "lme_text": lme_questions[v[1]]} for k, v in best.items()), key=lambda x: -x["jaccard"])[:15],
            "full_name_hits": full_name_hits,
            "name_token_hits": name_hits,
            "proper_noun_hits": proper_hits,
            "shared_shingle_sessions": {k: sorted(v)[:10] for k, v in shared_sessions.items()},
        }
        if label.startswith("longmemeval_s"):
            s_questions = lme_questions
        else:
            public["datasets"][label]["m_questions_absent_from_s"] = sum(1 for k, v in lme_questions.items() if s_questions.get(k) != v)
        print(f"{label}: {json.dumps(public['datasets'][label])}", file=sys.stderr)

    data_hits = {}
    for root, _, files in os.walk(a.eval_data):
        for fn in files:
            if not fn.endswith((".json", ".md", ".jsonl", ".ndjson", ".txt", ".html")):
                continue
            try:
                low = open(os.path.join(root, fn), encoding="utf-8", errors="ignore").read().lower()
            except OSError:
                continue
            for n in names:
                if n["full"] in low or (n["surname"] and re.search(r"\b" + re.escape(n["surname"]) + r"\b", low)):
                    data_hits.setdefault(n["full"], []).append(os.path.join(root, fn))
    public["gbrain_evals_data"] = {"persona_names_found_in_eval_data": len(data_hits)}
    private["gbrain_evals_data"] = data_hits

    cat13 = json.load(open(a.cat13_subset))
    cat13_q = [q.get("query") or q.get("text") or "" for q in cat13.get("queries", [])]
    best13 = max((jaccard(ss, content_set(t)) for _, ss in sealed_q_sets for t in cat13_q), default=0)
    concept_dir = os.path.join(a.eval_data, "world-v1")
    concepts = sorted(fn[len("concepts__"):-len(".json")].replace("-", " ") for fn in os.listdir(concept_dir) if fn.startswith("concepts__") and fn.endswith(".json"))
    concept_mentions = sum(1 for _, t in sealed_q for c in concepts if c in norm(t))
    public["cat13"] = {"queries_compared": len(cat13_q), "world_v1_concepts_checked": len(concepts), "max_question_jaccard": round(best13, 4), "sealed_questions_mentioning_a_cat13_concept": concept_mentions}

    os.makedirs(os.path.dirname(os.path.abspath(a.out_public)), exist_ok=True)
    json.dump(public, open(a.out_public, "w"), indent=2)
    open(a.out_public, "a").write("\n")
    json.dump(private, open(a.out_private, "w"), indent=1)
    print(json.dumps(public, indent=2))


if __name__ == "__main__":
    main()
