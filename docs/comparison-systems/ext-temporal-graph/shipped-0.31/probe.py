"""Live probe for the shipped-0.31 configuration: does every model graphiti-core 0.31.2 calls by default answer? (stdlib)

  models  One tiny real request per model, shaped the way graphiti-core sends it: gpt-6-luna through the Responses
          API with a structured output (reasoning effort none, verbosity low, prompt_cache_options explicit),
          gpt-4.1-mini through chat completions with max_tokens 1, logit_bias and logprobs (the cross-encoder), and
          text-embedding-3-small. Reads OPENAI_API_KEY; OPENAI_BASE_URL (default https://api.openai.com/v1) may
          point at a metering proxy instead.
  stack   Drive a running shim (bootstrap.sh up --config shipped-0.31): reset, ingest two short synthetic sessions,
          finish, one fixed-evidence search, reset. With --usage-log (the metering proxy's usage.ndjson for the run)
          it sums requests, tokens and cost per route and model, and ingest input tokens per input token sent.

    python3 docs/comparison-systems/ext-temporal-graph/shipped-0.31/probe.py models
    python3 docs/comparison-systems/ext-temporal-graph/shipped-0.31/probe.py stack --url http://127.0.0.1:8700 --usage-log <usage.ndjson>

Prices are USD per million tokens, copied from eval/runner/budget-ledger.ts (gpt-6-luna, gpt-4.1-mini) and gbrain's
embedding-pricing.ts (text-embedding-3-small) on 2026-10-29; the metering proxy's own cost field wins when present.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import time
import urllib.error
import urllib.request

PRICES = {"gpt-6-luna": (0.1, 0.5), "gpt-4.1-mini": (0.4, 1.6), "text-embedding-3-small": (0.02, 0.0)}
SESSIONS = [
    {"source_id": "src-probe-1", "event_time": "2026-03-02T10:00:00Z", "turns": [
        {"role": "user", "speaker": "Avery", "content": "I adopted a grey cat named Pebble last Saturday."},
        {"role": "assistant", "speaker": "Rowan", "content": "Congratulations, Avery. How is Pebble settling in?"},
        {"role": "user", "speaker": "Avery", "content": "Pebble sleeps on the bookshelf and ignores the new cat bed."}]},
    {"source_id": "src-probe-2", "event_time": "2026-04-14T18:30:00Z", "turns": [
        {"role": "user", "speaker": "Avery", "content": "Pebble had her first vet visit today; she weighs 4.2 kilograms."},
        {"role": "assistant", "speaker": "Rowan", "content": "Good news. Did the vet say anything else?"},
        {"role": "user", "speaker": "Avery", "content": "Only that Pebble should eat less dry food."}]},
]
QUESTION = "How much did Avery's cat weigh at her first vet visit?"


def post(url: str, body: dict, key: str | None = None, timeout: float = 600) -> dict:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"POST {url} -> {e.code} {e.read().decode()[:600]}") from e


def cost(model: str, inp: int, out: int) -> float:
    pi, po = PRICES[model]
    return (inp * pi + out * po) / 1e6


def models() -> int:
    key = os.environ.get("OPENAI_API_KEY") or sys.exit("models needs OPENAI_API_KEY")
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    rows = []
    schema = {"type": "object", "additionalProperties": False, "required": ["entities"],
              "properties": {"entities": {"type": "array", "items": {"type": "string"}}}}
    r = post(f"{base}/responses", {
        "model": "gpt-6-luna", "max_output_tokens": 200, "reasoning": {"effort": "none"}, "prompt_cache_options": {"mode": "explicit"},
        "text": {"verbosity": "low", "format": {"type": "json_schema", "name": "Entities", "schema": schema, "strict": True}},
        "input": [{"role": "system", "content": "Extract the named entities."}, {"role": "user", "content": "Avery adopted a cat named Pebble."}]}, key)
    text = next(c["text"] for o in r["output"] if o["type"] == "message" for c in o["content"] if c["type"] == "output_text")
    u = r["usage"]
    rows.append({"route": "/v1/responses", "model_requested": "gpt-6-luna", "model_answered": r["model"], "input_tokens": u["input_tokens"],
                 "output_tokens": u["output_tokens"], "reasoning_tokens": u.get("output_tokens_details", {}).get("reasoning_tokens"),
                 "answer": json.loads(text), "usd": cost("gpt-6-luna", u["input_tokens"], u["output_tokens"])})
    r = post(f"{base}/chat/completions", {
        "model": "gpt-4.1-mini", "temperature": 0, "max_tokens": 1, "logit_bias": {"6432": 1, "7983": 1}, "logprobs": True, "top_logprobs": 2,
        "messages": [{"role": "system", "content": "You are an expert tasked with determining whether the passage is relevant to the query"},
                     {"role": "user", "content": 'Respond with "True" if PASSAGE is relevant to QUERY and "False" otherwise.\n<PASSAGE>Pebble weighs 4.2 kilograms.</PASSAGE>\n<QUERY>How heavy is Pebble?</QUERY>'}]}, key)
    u = r["usage"]
    top = r["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    rows.append({"route": "/v1/chat/completions", "model_requested": "gpt-4.1-mini", "model_answered": r["model"], "input_tokens": u["prompt_tokens"],
                 "output_tokens": u["completion_tokens"], "answer": [(t["token"], round(t["logprob"], 4)) for t in top],
                 "usd": cost("gpt-4.1-mini", u["prompt_tokens"], u["completion_tokens"])})
    r = post(f"{base}/embeddings", {"model": "text-embedding-3-small", "input": ["Pebble weighs 4.2 kilograms."]}, key)
    u = r["usage"]
    rows.append({"route": "/v1/embeddings", "model_requested": "text-embedding-3-small", "model_answered": r["model"], "input_tokens": u["prompt_tokens"],
                 "output_tokens": 0, "answer": f"{len(r['data'][0]['embedding'])} dimensions (graphiti-core keeps the first 1024)",
                 "usd": cost("text-embedding-3-small", u["prompt_tokens"], 0)})
    for row in rows:
        print(json.dumps(row))
    print(json.dumps({"total_usd": round(sum(r["usd"] for r in rows), 6)}))
    return 0


def summarize(path: str) -> dict:
    by = collections.defaultdict(lambda: {"requests": 0, "input_tokens": 0, "output_tokens": 0, "usd": 0.0})
    for line in open(path):
        row = json.loads(line)
        model, route = row.get("model") or "?", row.get("route") or "?"
        b = by[f"{route} {model}"]
        b["requests"] += 1
        b["input_tokens"] += int(row.get("input_tokens") or 0)
        b["output_tokens"] += int(row.get("output_tokens") or 0)
        b["usd"] += float(row.get("actual_usd") or 0) or (cost(model, int(row.get("input_tokens") or 0), int(row.get("output_tokens") or 0)) if model in PRICES else 0)
    return dict(by)


def stack(url: str, usage_log: str | None) -> int:
    url = url.rstrip("/")
    ns = f"ns-probe-{int(time.time())}"
    post(f"{url}/reset", {"ns": ns})
    sent_chars = 0
    for s in SESSIONS:
        t0 = time.time()
        out = post(f"{url}/ingest", {"ns": ns, "session": s})
        sent_chars += sum(len(f"{t['speaker']}: {t['content']}") + 1 for t in s["turns"])
        print(json.dumps({"step": "ingest", "source_id": s["source_id"], "receipt": out.get("receipt"), "seconds": round(time.time() - t0, 1)}))
    marks = {"after_ingest": sum(1 for _ in open(usage_log)) if usage_log else None}
    post(f"{url}/finish", {"ns": ns, "timeout_s": 60})
    res = post(f"{url}/retrieve", {"ns": ns, "question": QUESTION, "query_time": None, "policy": {"name": "probe", "mode": "fixed-evidence", "settings": {}}})
    print(json.dumps({"step": "retrieve", "items": len(res["items"]), "top": [i["text"][:120] for i in res["items"][:3]]}))
    post(f"{url}/reset", {"ns": ns})
    if usage_log:
        lines = open(usage_log).read().splitlines()
        tmp = usage_log + ".ingest"
        with open(tmp, "w") as f:
            f.write("\n".join(lines[:marks["after_ingest"]]) + "\n")
        ingest, total = summarize(tmp), summarize(usage_log)
        ingest_in = sum(v["input_tokens"] for v in ingest.values())
        print(json.dumps({"step": "usage", "ingest": ingest, "all": total,
                          "session_text_tokens_estimate": round(sent_chars / 4), "ingest_input_tokens": ingest_in,
                          "ingest_input_per_session_token": round(ingest_in / max(1, sent_chars / 4), 1),
                          "total_usd": round(sum(v["usd"] for v in total.values()), 6)}))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["models", "stack"])
    ap.add_argument("--url", default="http://127.0.0.1:8700")
    ap.add_argument("--usage-log")
    a = ap.parse_args()
    sys.exit(models() if a.mode == "models" else stack(a.url, a.usage_log))
