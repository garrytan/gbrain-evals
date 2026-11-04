#!/usr/bin/env python3
"""RS1 mint driver: one step of one conversation, run by mint.sh in custody.

mint.sh calls 'step' once per (conversation, step) inside 'env -i' with an
explicit allowlist, so each step process holds at most one provider
credential: a metering-proxy token for the one provider that step calls. The
driver derives the conversation's seed from the private seed file, runs the
step, records its outputs with their sha256 in the conversation's manifest and
prints one line of counts and hashes. A step whose manifest entry is done is
never run again; its outputs are verified against the recorded sha256 instead.

Modes:
  fake        no BEAM, no network, no third-party Python: a deterministic stub
              writes BEAM-shaped files. The keyless tests drive this mode.
  stub-model  BEAM's own pipeline code at the pinned commit with a
              deterministic stub in place of every model call (needs the venv).
  real        BEAM's pipeline with gemini-3.8-flash in every model slot and
              OpenAI text-embedding-3-large for the topic check, each reached
              only through the metering proxy named in RS1_PROXY_READY.

Nothing BEAM prints reaches stdout or stderr: file descriptors 1 and 2 point at
/dev/null while a step runs, and an error prints only its class and the sha256
of its message. The traceback stays in custody beside the conversation
(errors/<step>.traceback), with the RS1 text it may quote.

Gap checks: BEAM's question and answer steps call the model inside loops that
swallow any Exception (src/beam/main.py:1531 and 2079), so a transient error
that outlasts the client's resend loses output without stopping the step. Each
of those steps compares what BEAM wrote with what it was asked to write and
fails with counts only when they differ. The answer step also fails a batch
during which any model call raised: BEAM retries nothing there, so a swallowed
error can lose a follow-up or a summary and leave no gap in the output.
'check-gaps --out <dir>' runs the output checks over an existing mint's finished
steps. Every other model call BEAM makes
here (plan: profile_creation.py:116, main.py:543, 799 and 989; probe: main.py
2160, 2330 and 2478) sits outside any try, so an error stops the step.
"""
import argparse
import hashlib
import hmac
import json
import math
import os
import pickle
import re
import shutil
import sys
import threading
import traceback
import types
from pathlib import Path

BEAM_COMMIT = "b2da22eac88bb0874c64665f13457eb99835774a"
CHAT_SIZE = "1M"
# BEAM src/beam/adjust_chats_length.py terunicate_chats: the 1M tier's limit, counted for a gemini model with tiktoken's
# gpt-4o-mini encoding.
TRUNCATE_TOKENS = 1_040_000
GEN_MODEL = "gemini-3.8-flash"
# gemini-3.8-flash reasons before it answers and counts those tokens against maxOutputTokens, while BEAM sized each
# max_tokens for a non-reasoning model. Every call sends the lowest thinking level the model accepts ("minimal" returns
# an error on 3.8 Flash, and thinkingBudget, which could cap reasoning, is deprecated on Gemini 3 and refused beside a
# level). No level caps reasoning, so a call with BEAM's max_tokens asks for that many tokens plus reasoning_headroom,
# sized from stage 0: answer-step reasoning had a p99 under 6,000 tokens at the default level, medium.
GEN_THINKING = {"thinking_level": "low", "reasoning_headroom": 8192}
# validate.ts VALIDATOR_IDS: the two paid validators a real mint's regeneration report must name.
PAID_VALIDATORS = ["gemini:gemini-3.8-flash", "anthropic:claude-haiku-5-5"]
EMBED_MODEL = "text-embedding-3-large"
TOPIC_COSINE_MAX = 0.85
TOPIC_JACCARD_MAX = 0.6
TOPIC_ATTEMPTS = 5
# BEAM src/beam/run_pipeline.py:205-224, run_question_generation at chat size 1M: 10 batches of 10 sub-batches, and a
# BATCH_SIZE of 90 (general) or 60 (coding, math), so each sub-batch asks the model for 9 or 6 user messages.
QUESTION_BATCHES = 10
QUESTION_SUB_BATCHES = 10
QUESTION_SUB_BATCH_SIZE = {"general": 9, "coding": 6, "math": 6}
# The first selection plus two regenerations (draft prereg: a failed item is regenerated up to twice).
SELECT_ATTEMPTS = 3
ITEMS_PER_ABILITY = 2
ABILITIES = [
    "abstention", "contradiction_resolution", "event_ordering", "information_extraction", "instruction_following",
    "knowledge_update", "multi_session_reasoning", "preference_following", "summarization", "temporal_reasoning",
]
# The field holding each ability's reference answer in BEAM's probing_questions.json.
ANSWER_FIELD = {
    "abstention": "ideal_response", "contradiction_resolution": "ideal_answer", "event_ordering": "answer",
    "information_extraction": "answer", "instruction_following": "expected_compliance", "knowledge_update": "answer",
    "multi_session_reasoning": "answer", "preference_following": "expected_compliance", "summarization": "ideal_summary",
    "temporal_reasoning": "answer",
}
# Steps in order, with the one provider each may call (None: keyless).
STEPS = {
    "topic": "gemini", "topic_check": "openai", "plan": "gemini", "question": "gemini", "answer": "gemini",
    "chat_json": None, "truncate": None, "probe": "gemini", "select": None, "rubric": "gemini",
}
SEED_RE = re.compile(r"rs1-seed-v1:([0-9a-f]{64})\n?")
SEED_SUFFIX = ".rs1-seed"
# Every topic file carries this marker; the sealed key in .gstack/pregate.json refuses a commit line that holds it.
# It is assembled here so that this source file does not hold it.
CUSTODY_MARKER = "RS1-" + "SEALED-" + "CUSTODY-v1"
FACETS = [
    "a tight budget", "a move to a new city", "a small team", "a family obligation", "a health constraint",
    "a hard deadline", "a volunteer group", "a rural setting", "a second career", "a seasonal business",
    "an aging parent", "a long commute", "a shared household", "a legacy system", "a regulatory change",
    "a first attempt", "a recovery from a setback", "a hobby turning serious", "a remote collaborator",
    "a cross-border situation", "a slow internet connection", "a noisy neighbour", "a cautious investor",
    "a competition entry", "a public presentation", "a certification exam", "an unusual climate", "a night shift",
    "a newborn at home", "a pet with special needs", "a community event", "a nonprofit", "a mentor relationship",
    "a language barrier", "an inherited property", "a part-time schedule", "a disability accommodation",
    "a supply shortage", "a sports injury", "a vintage collection", "a partnership dispute", "a data migration",
    "an open-source contribution", "a classroom", "a research deadline", "a food allergy", "a renovation",
    "a wedding", "a relocation for work", "a career break", "a negotiation", "a fundraising goal",
]

TOPIC_PROMPT = """You are creating the seed for one long, realistic conversation between a user and an AI assistant. The conversation will span several months and about a million tokens, in the style of the BEAM long-term memory benchmark.

Write one new topic in the category "{category}". Let these ideas shape it: {facets}. The topic must be specific and must not repeat any of these existing topics:
{avoid}

Return only a JSON object with these keys:
- "category": exactly "{category}"
- "title": a concrete title of at most 15 words
- "theme": one sentence on what the user is trying to achieve
- "subtopics": a list of 8 short subtopics the conversation will cover
"""

RUBRIC_PROMPT = """You write grading rubrics for the BEAM long-term memory benchmark. A judge scores a response against each rubric item separately, so every item must be one short, checkable statement.

Probing question type: {ability}
Question: {question}
Reference answer: {answer}

Write 1 to 6 rubric items. {rule}
Return only a JSON object: {{"rubric": ["...", "..."]}}
"""

RUBRIC_RULES = {
    "abstention": 'Each item starts with "Based on the provided chat, there is no information related to" and names one missing detail.',
    "contradiction_resolution": 'The first item is "LLM response should state: there is contradictory information". Then one "LLM response should mention: ..." item for each conflicting statement, and a last item "LLM response should mention: which statement is correct?".',
    "event_ordering": 'Write one "LLM response should mention: <event>" item per event, in the order the reference gives them.',
    "information_extraction": 'Write one "LLM response should state: <fact>" item per fact the reference gives.',
    "instruction_following": 'Write "LLM response should contain: <observable sign of compliance>" items.',
    "knowledge_update": 'Write one "LLM response should state: <updated value>" item per updated fact.',
    "multi_session_reasoning": 'Write one "LLM response should state: <conclusion or step>" item per key part of the reference.',
    "preference_following": 'Write "LLM response should contain: <observable sign that the preference is followed>" items.',
    "summarization": 'Write one "LLM response should contain: <key element>" item per element of the reference summary.',
    "temporal_reasoning": 'Write one "LLM response should state: <value>" item for the computed answer and one for the dates or events it relies on.',
}


class StepFailure(Exception):
    """A refusal whose message names no RS1 text, so mint.sh may print it."""


# ---------------------------------------------------------------------------------------------------- hashing, seeds


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def inside_git_worktree(path):
    p = Path(path).resolve()
    return any((parent / ".git").exists() for parent in [p, *p.parents])


def read_seed(path):
    p = Path(path)
    if not p.name.endswith(SEED_SUFFIX):
        raise StepFailure(f"the seed file name must end with {SEED_SUFFIX}")
    if inside_git_worktree(p):
        raise StepFailure("the seed file must not sit inside a git checkout")
    mode = p.stat().st_mode & 0o777
    if mode & 0o077:
        raise StepFailure(f"the seed file is readable by group or others (mode {mode:o}); chmod 600 it")
    m = SEED_RE.fullmatch(p.read_text(encoding="ascii"))
    if not m:
        raise StepFailure("the seed file must hold one line: rs1-seed-v1: and 64 lower-case hex digits")
    return bytes.fromhex(m.group(1))


def derive(key, label):
    return hmac.new(key, label.encode("utf-8"), hashlib.sha256).digest()


def conversation_seed(seed, index):
    """HMAC-SHA256 of the conversation index under the private seed."""
    return derive(seed, f"rs1/conversation/{index}")


def seeded_int(key, label):
    return int.from_bytes(derive(key, label)[:8], "big")


# ---------------------------------------------------------------------------------------------------- files, manifest


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class Manifest:
    """Per-conversation record of every finished step attempt and the sha256 of each of its outputs."""

    def __init__(self, conv, cid, index, mode):
        self.conv = conv
        self.path = conv / "manifest.json"
        self.lock = threading.Lock()
        if self.path.exists():
            self.data = read_json(self.path)
            if self.data.get("mode") != mode:
                raise StepFailure(f"{cid} was minted in {self.data.get('mode')} mode, not {mode}")
        else:
            self.data = {"schema": "rs1-mint-manifest/v1", "conversation": cid, "index": index, "mode": mode,
                         "beam_commit": BEAM_COMMIT, "steps": {}}

    def entry(self, step, attempt):
        return self.data["steps"].get(f"{step}@{attempt}")

    def done(self, step, attempt):
        return (self.entry(step, attempt) or {}).get("status") == "done"

    def attempts(self, step):
        return sorted(int(k.split("@")[1]) for k in self.data["steps"] if k.split("@")[0] == step)

    def latest(self, step):
        a = self.attempts(step)
        return a[-1] if a else 0

    def accepted_topic(self):
        return next((a for a in self.attempts("topic_check") if self.entry("topic_check", a).get("verdict") == "accepted"), None)

    def save(self, step, attempt, value):
        with self.lock:
            self.data["steps"][f"{step}@{attempt}"] = value
            write_json(self.path, self.data)

    def hashes(self, rels):
        return {rel: sha256_file(self.conv / rel) for rel in sorted(set(rels))}

    def verify(self, step, attempt):
        entry = self.entry(step, attempt)
        recorded = dict(entry.get("outputs", {}))
        for part in entry.get("parts", {}).values():
            recorded.update(part["outputs"])
        for rel, digest in recorded.items():
            p = self.conv / rel
            if not p.is_file() or sha256_file(p) != digest:
                raise StepFailure(f"{step}@{attempt} is recorded as finished but {rel} is missing or changed; "
                                  "restore it from the encrypted archive (finished outputs are never regenerated)")
        return recorded


# ---------------------------------------------------------------------------------------------------- usage


class Usage:
    """Counts-only usage, appended per model call so a crashed step's calls still count, and the number of model calls
    that raised (in memory only), which the answer step reads per batch."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.errors = 0
        path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, model, input_tokens, output_tokens, **request):
        line = json.dumps({"model": model, "input_tokens": int(input_tokens or 0),
                           "output_tokens": int(output_tokens or 0), **request})
        with self.lock, open(self.path, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def record_error(self):
        with self.lock:
            self.errors += 1

    def totals(self):
        t = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "capped": 0}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                r = json.loads(line)
                t["calls"] += 1
                t["input_tokens"] += r["input_tokens"]
                t["output_tokens"] += r["output_tokens"]
                t["capped"] += int(r.get("capped", False))
        return t


# ---------------------------------------------------------------------------------------------------- models


def text_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("content", ""))
    if isinstance(value, (list, tuple)):
        return "\n".join(text_of(v) for v in value)
    return str(getattr(value, "content", value))


class ProviderRefusal(BaseException):
    """A model call refused with an HTTP status a resend would not change: a 4xx other than 408 and 429, the metering
    proxy's 402 budget refusal included. A BaseException, so BEAM's 'except Exception' retry loops cannot swallow it
    and leave a step recorded as done without its output. Its message is the status and the error class only."""


def refusal_status(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        code = getattr(error, "code", None)
        if isinstance(code, int) and 400 <= code < 500 and code not in (408, 429):
            return code
        error = error.__cause__ or error.__context__
    return None


class Reply:
    def __init__(self, content, usage_metadata):
        self.content = content
        self.usage_metadata = usage_metadata


class RecordingModel:
    """What BEAM sees as an LLM: '.invoke()' that records usage. BEAM's 'max_tokens=' keyword, the one generation
    setting BEAM passes per call, becomes Gemini's 'max_output_tokens' plus GEN_THINKING's reasoning headroom, so
    reasoning cannot shrink the reply BEAM asked for. Each call's usage line records the thinking level, the limit sent
    and whether the reply stopped at that limit (finish reason MAX_TOKENS). BEAM's question step sends a prompt made
    only of system messages; Gemini rejects a request with no contents (HTTP 400), so such a prompt goes as one user
    turn of the same text, as an OpenAI chat model would read it. A refusal a resend would not change raises
    ProviderRefusal."""

    def __init__(self, inner, model_id, usage):
        self.inner, self.model_id, self.usage = inner, model_id, usage

    def invoke(self, value, max_tokens=None, **kwargs):
        limit = None
        if max_tokens is not None:
            limit = max_tokens + GEN_THINKING["reasoning_headroom"]
            kwargs["generation_config"] = {**kwargs.get("generation_config", {}), "max_output_tokens": limit}
        if isinstance(value, (list, tuple)) and value and all(getattr(m, "type", None) == "system" for m in value):
            value = text_of(value)
        try:
            reply = self.inner.invoke(value, **kwargs)
        except Exception as error:
            self.usage.record_error()
            status = refusal_status(error)
            if status is None:
                raise
            raise ProviderRefusal(f"HTTP {status} {type(error).__name__}") from error
        meta = getattr(reply, "usage_metadata", None) or {}
        finish = (getattr(reply, "response_metadata", None) or {}).get("finish_reason")
        self.usage.record(self.model_id, meta.get("input_tokens", 0), meta.get("output_tokens", 0),
                          thinking_level=GEN_THINKING["thinking_level"], max_output_tokens=limit,
                          capped=finish == "MAX_TOKENS")
        return reply


def proxy_endpoint(provider):
    """Base URL and proxy token for one provider from the metering proxy's ready file; real mode reaches providers
    only here."""
    ready = os.environ.get("RS1_PROXY_READY")
    if not ready:
        raise StepFailure("real mode needs RS1_PROXY_READY (mint.sh starts a metering proxy per paid step)")
    env = read_json(ready)["env"]["rs1"]
    base_var, key_var = {"gemini": ("GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY"), "openai": ("OPENAI_BASE_URL", "OPENAI_API_KEY")}[provider]
    base, token = env.get(base_var), env.get(key_var)
    if not base or not token:
        raise StepFailure(f"the metering proxy does not serve {provider} for this step")
    if not re.match(r"^http://127\.0\.0\.1:\d+/", base):
        raise StepFailure("the provider base URL is not the loopback metering proxy")
    return base, token


def gemini_model(temperature, usage):
    from langchain_google_genai import ChatGoogleGenerativeAI

    base, token = proxy_endpoint("gemini")
    inner = ChatGoogleGenerativeAI(model=GEN_MODEL, google_api_key=token, transport="rest",
                                   client_options={"api_endpoint": base}, temperature=temperature)
    send_thinking(inner.client.transport._session)
    return RecordingModel(inner, f"gemini:{GEN_MODEL}", usage)


def send_thinking(session):
    """Add GEN_THINKING's level to the JSON body of every generateContent request an HTTP session sends.
    langchain-google-genai 2.0.10, BEAM's pin, builds each request from a google-ai-generativelanguage 0.6.15 protobuf
    that has no thinkingConfig field, so the setting cannot travel through the client itself."""
    request = session.request

    def with_thinking(method, url, data=None, **kwargs):
        if data and re.search(r":(generateContent|streamGenerateContent)\b", url):
            body = json.loads(data)
            config = body.setdefault("generationConfig", {})
            config["thinkingConfig"] = {"thinkingLevel": GEN_THINKING["thinking_level"]}
            data = json.dumps(body)
        return request(method, url, data=data, **kwargs)

    session.request = with_thinking


class UnmeteredSlot:
    """BEAM's model slot in a real-mode step that mint.sh gives no metering proxy (chat_json, truncate). Those steps
    make no model call, and one would bypass metering, so every call refuses."""

    def invoke(self, value, **kwargs):
        raise StepFailure("this step has no metering proxy, so it makes no model call")


class StubModel:
    """Deterministic stand-in for every model call (stub-model mode). It answers each BEAM prompt template in the
    format BEAM's parser expects, recognizing the template by its literal prefix, and RS1's own topic and rubric
    prompts by theirs."""

    def __init__(self, key, usage):
        self.key, self.usage, self.model_id = key, usage, "stub"
        self.templates = []

    def bind_templates(self, prompts):
        kinds = {
            "labels": ["label_generation_prompt_template", "coding_label_generation_prompt_template",
                       "math_label_generation_prompt_template"],
            "plan": ["plan_generation_prompt_profile_and_topic_given_detailed_template",
                     "coding_plan_generation_prompt_detailed", "math_plan_generation_prompt_detailed",
                     "add_special_bulletpoints_to_plan_implicit"],
            "messages": ["message_generation_prompt_focused_template_fast",
                         "message_generation_prompt_focused_template_fast_special",
                         "coding_message_generation_prompt_fast", "math_message_generation_prompt_fast"],
            "yesno": ["check_include_question_template", "check_need_followup_template"],
            "candidates": ["information_extraction_prompt", "multi_session_reasoning_prompt",
                           "knowledge_update_special_bullets_prompt", "temporal_reasoning_prompt",
                           "preference_following_prompt", "event_ordering_prompt", "contradiction_resolution_prompt",
                           "summarization_prompt", "instruction_following_prompt"],
            "question": [n for n in dir(prompts) if re.search(r"_probing_question_(easy|medium|hard|final)_prompt$", n)],
        }
        for kind, names in kinds.items():
            for name in names:
                template = getattr(prompts, name, None)
                if isinstance(template, str):
                    prefix = re.split(r"[<{]", template, maxsplit=1)[0].strip()
                    if len(prefix) >= 40:
                        self.templates.append((prefix, kind, name))
        self.templates.sort(key=lambda t: -len(t[0]))

    def kind_of(self, value):
        texts = [text_of(v).strip() for v in value] if isinstance(value, (list, tuple)) else [text_of(value).strip()]
        if any(t.startswith(TOPIC_PROMPT[:40]) for t in texts):
            return "topic", None
        if any(t.startswith(RUBRIC_PROMPT[:40]) for t in texts):
            return "rubric", None
        for prefix, kind, name in self.templates:
            if any(t.startswith(prefix) for t in texts):
                return kind, name
        return "text", None

    def words(self, label, n):
        out, i = [], 0
        while len(out) < n:
            digest = derive(self.key, f"{label}/{i}").hex()
            out.extend(f"w{digest[j:j + 5]}" for j in range(0, 60, 6))
            i += 1
        return " ".join(out[:n])

    def invoke(self, value, **kwargs):
        prompt = text_of(value)
        kind, name = self.kind_of(value)
        label = sha256_bytes(prompt.encode("utf-8"))[:16]
        if kind == "topic":
            content = json.dumps({"category": re.search(r'category "([^"]+)"', prompt).group(1),
                                  "title": "Stub topic " + self.words(label, 4), "theme": self.words(label + "t", 10),
                                  "subtopics": [self.words(f"{label}s{i}", 3) for i in range(8)]})
        elif kind == "rubric":
            content = json.dumps({"rubric": ["LLM response should state: " + self.words(label, 6)]})
        elif kind == "labels":
            content = "**Personal Labels:**\n- " + self.words(label, 6) + "\n- " + ", ".join(self.words(f"{label}{i}", 2) for i in range(4))
        elif kind == "plan":
            batches = []
            for b in range(1, 11):
                bullets = [f"• **Time Anchor:** March {b}, 2024"] + [f"• **Point {k}:** {self.words(f'{label}b{b}k{k}', 8)}" for k in range(2, 28)]
                bullets += [f"• **Information Update:** {self.words(f'{label}u{b}', 8)}",
                            f"• **User Instruction:** {self.words(f'{label}i{b}', 8)}",
                            f"• **Logical Contradiction:** {self.words(f'{label}c{b}', 8)}"]
                batches.append(f"BATCH {b} PLAN\n" + "\n".join(bullets))
            content = "\n\n".join(batches)
        elif kind == "messages":
            lines = [f"{self.words(f'{label}m{i}', 12)}? ->-> {i + 1}" for i in range(12)]
            content = "\n---MESSAGE_SEPARATOR---\n".join(lines) if "MESSAGE_SEPARATOR" in prompt else "\n".join(lines)
        elif kind == "yesno":
            content = "no"
        elif kind == "candidates":
            content = json.dumps([{"batch_numbers": "1", "bullet_numbers": str(k), "bullet_points": self.words(f"{label}p{k}", 6)} for k in (2, 3)])
        elif kind == "question":
            ability = next((a for a in ABILITIES if name.startswith(a)), "information_extraction")
            ids = [int(x) for x in re.findall(r"chat_id: (\d+)", prompt)[:2]] or [0]
            item = {"question": self.words(label + "q", 12) + "?", ANSWER_FIELD[ability]: self.words(label + "a", 8),
                    "difficulty": "easy", "source_chat_ids": ids}
            content = json.dumps([item] if ability == "abstention" else item)
        else:
            content = self.words(label, 40)
        tokens = {"input_tokens": len(prompt) // 4, "output_tokens": len(content) // 4}
        self.usage.record(self.model_id, tokens["input_tokens"], tokens["output_tokens"])
        return Reply(content, tokens)


def embed(texts, mode, usage):
    """Topic embeddings: OpenAI text-embedding-3-large through the proxy in real mode, a hashed bag of words otherwise."""
    if mode != "real":
        vectors = []
        for text in texts:
            v = [0.0] * 256
            for word in normalize(text).split():
                v[int(sha256_bytes(word.encode("utf-8"))[:8], 16) % 256] += 1.0
            vectors.append(v)
        return vectors
    import urllib.request

    base, token = proxy_endpoint("openai")
    req = urllib.request.Request(base.rstrip("/") + "/embeddings", method="POST",
                                 data=json.dumps({"model": EMBED_MODEL, "input": texts}).encode("utf-8"),
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        body = json.loads(res.read())
    usage.record(f"openai:{EMBED_MODEL}", (body.get("usage") or {}).get("prompt_tokens", 0), 0)
    return [d["embedding"] for d in sorted(body["data"], key=lambda d: d["index"])]


def cosine(a, b):
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
    return 0.0 if na == 0 or nb == 0 else sum(x * y for x, y in zip(a, b)) / (na * nb)


# ---------------------------------------------------------------------------------------------------- BEAM


def load_beam(beam_dir, slot_model):
    """Import BEAM's pipeline with our model object in every slot of src/llm.py, whose 'gpt' slot is hard-coded to
    gpt-4.1-mini. BEAM's files stay byte-identical to the pinned commit."""
    sys.path.insert(0, str(beam_dir))
    import src

    shim = types.ModuleType("src.llm")

    class BuildLLm:
        def __init__(self, *args, **kwargs):
            raise StepFailure("BEAM's BuildLLm is reached only by its 10M paths, which RS1 does not use")

    shim.BuildLLm = BuildLLm
    shim.gpt_llm = shim.llama_llm = shim.qwen_llm = slot_model
    shim.english_only_regex = ""
    sys.modules["src.llm"] = shim
    src.llm = shim
    from src import prompts
    from src.beam import adjust_chats_length, main, run_pipeline, utils

    return types.SimpleNamespace(prompts=prompts, main=main, run_pipeline=run_pipeline, utils=utils, adjust=adjust_chats_length)


def seed_rngs(key):
    """BEAM's profile builder draws from random, numpy and Faker without a seed; seed all three from the conversation."""
    import random

    import numpy
    from faker import Faker

    n = seeded_int(key, "beam-rng")
    random.seed(n)
    numpy.random.seed(n % (2 ** 32))
    Faker.seed(n)


# ---------------------------------------------------------------------------------------------------- topics


def normalize(text):
    return " ".join(re.sub(r"[^0-9a-z]+", " ", str(text).lower()).split())


def topic_text(t):
    return f"{t['title']}. {t['theme']}. Subtopics: {', '.join(t['subtopics'])}"


def public_topics(beam_dir):
    out = []
    for path in sorted((Path(beam_dir) / "topics").glob("*/*.json")):
        out.extend({k: t[k] for k in ("category", "title", "theme", "subtopics")} for t in read_json(path))
    return out


def public_1m_topics(beam_dir):
    return read_json(Path(beam_dir) / "topics" / "1M" / "1M_topics.json")


def valid_topic(t):
    return (isinstance(t, dict) and all(isinstance(t.get(k), str) and t[k].strip() for k in ("category", "title", "theme"))
            and isinstance(t.get("subtopics"), list) and len(t["subtopics"]) >= 3
            and all(isinstance(s, str) and s.strip() for s in t["subtopics"]))


def parse_json_object(text):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise StepFailure("the model reply holds no JSON object")
    return json.loads(text[start:end + 1])


# ---------------------------------------------------------------------------------------------------- fake pipeline

FAKE_BATCHES, FAKE_TURNS, FAKE_CANDIDATES = 10, 6, 4


def fake_words(key, label, n):
    out, i = [], 0
    while len(out) < n:
        digest = derive(key, f"{label}/{i}").hex()
        out.extend(f"q{digest[j:j + 5]}" for j in range(0, 60, 6))
        i += 1
    return " ".join(out[:n])


def fake_fact(key, ability, k):
    return "fact " + derive(key, f"fact/{ability}/{k}").hex()[:12]


def fake_fact_message(ability, k):
    """The id of the user message the fake chat plants a candidate's answer in."""
    return 2 * ((ABILITIES.index(ability) * FAKE_CANDIDATES + k) % (FAKE_BATCHES * FAKE_TURNS))


def fake_topic(ctx, attempt, category):
    if os.environ.get("RS1_FAKE_TOPIC_COLLIDE") == str(ctx.index) and attempt == 1:
        return dict(public_topics(ctx.beam_dir)[0])
    tag = derive(ctx.key, f"topic/{attempt}").hex()[:8]
    return {"category": category, "title": f"Fake custody topic {tag} {fake_words(ctx.key, f'topic/{attempt}/title', 4)}",
            "theme": fake_words(ctx.key, f"topic/{attempt}/theme", 10),
            "subtopics": [fake_words(ctx.key, f"topic/{attempt}/subtopic/{i}", 3) for i in range(8)]}


def fake_chat(key):
    planted = {}
    for ability in ABILITIES[1:]:
        for k in range(FAKE_CANDIDATES):
            planted.setdefault(fake_fact_message(ability, k), []).append(fake_fact(key, ability, k))
    batches, mid = [], 0
    for b in range(1, FAKE_BATCHES + 1):
        turns = []
        for t in range(1, FAKE_TURNS + 1):
            turn = []
            for role in ("user", "assistant"):
                content = " ".join([fake_words(key, f"msg/{mid}", 60), *planted.get(mid, [])])
                message = {"role": role, "id": mid, "index": f"{b},{t}", "content": content}
                if role == "user":
                    message.update({"time_anchor": f"March-{b:02d}-2024", "question_type": "main_question"})
                turn.append(message)
                mid += 1
            turns.append(turn)
        batches.append({"batch_number": b, "time_anchor": f"March-{b:02d}-2024", "turns": turns})
    return batches


def fake_candidates(key, ability):
    groups = []
    for k in range(FAKE_CANDIDATES):
        nonce = derive(key, f"candidate/{ability}/{k}").hex()[:10]
        if ability == "abstention":
            item = {"question": f"What did I decide about nonce-{nonce}?", "difficulty": "easy",
                    "ideal_response": f"Based on the provided chat, there is no information related to nonce-{nonce}.",
                    "abstention_type": "missing_detail", "plan_reference": "Batch 1, Bullet 2"}
        else:
            item = {"question": f"Fake {ability} question {nonce}?", "difficulty": "easy",
                    ANSWER_FIELD[ability]: fake_fact(key, ability, k), "source_chat_ids": [fake_fact_message(ability, k)]}
        groups.append([[item]])
    return groups


# ---------------------------------------------------------------------------------------------------- candidates


def flatten_candidates(value, path=()):
    """Every dict with a question inside BEAM's nested candidate files, keyed by its index path."""
    if isinstance(value, dict):
        if isinstance(value.get("question"), str) and value["question"].strip():
            yield ".".join(map(str, path)) or "0", value
        return
    if isinstance(value, list):
        for i, v in enumerate(value):
            yield from flatten_candidates(v, path + (i,))


def candidate_file(beam_chat, ability):
    return beam_chat / "probing_questions" / ability / f"{ability}.json"


def usable(ability, item):
    answer = item.get(ANSWER_FIELD[ability])
    return isinstance(answer, str) and bool(answer.strip()) and (ability == "abstention" or bool(item.get("source_chat_ids")))


# ---------------------------------------------------------------------------------------------------- gap checks


def read_pickle(path):
    with open(path, "rb") as f:
        return pickle.load(f)


def write_pickle(path, value):
    tmp = Path(path).with_name(Path(path).name + ".tmp")
    with open(tmp, "wb") as f:
        pickle.dump(value, f)
    os.replace(tmp, path)


def domain_of(conv):
    """BEAM's domain for a conversation, from its category as run_pipeline.py maps it."""
    category = read_json(conv / "topic.json")["category"].lower()
    return category if category in ("math", "coding") else "general"


def instruction_line(plan_text, batch_number):
    """The line BEAM's question step inserts for a batch's User Instruction bullet, between the two lines its last
    (special) sub-batch asks the model for: main.py:684 extract_plan_bullets, then main.py:1344, 1384 and 1539-1563."""
    found = re.findall(r"• \*\*(.+?):\*\*(.+?)(?=• \*\*|\n|$)", plan_text, re.DOTALL)
    bullets = [f"{label.strip()}: {content.strip()}" for label, content in found]
    if len(bullets) < 3 or "User Instruction:" not in bullets[-2]:
        return None
    line = re.sub(r"^\d+\)\s*", "", (bullets[-2] + f" ->-> {len(bullets) - 1}").split("User Instruction:")[1].strip())
    return line.split("->->")[0].strip() + f" ->-> {batch_number},{line.split('->->')[1].strip()}"


def question_gaps(questions, plans, domain):
    """user_messages.pickle against what BEAM's question step asks for (main.py:1307). Each batch's normal sub-batches
    ask for QUESTION_SUB_BATCH_SIZE lines each, and its special sub-batch for two lines around the inserted instruction,
    so a batch holds at most 10 * size + 3 lines. BEAM's dedup drops a few: its 35 published 1M chats hold 87 to 93 lines
    per general batch and 60 to 63 per coding or math batch. A batch under 85 (general) or 58 (coding, math) lines is
    short by at least one whole sub-batch, and a batch whose instruction line is not second to last lost a line of its
    special sub-batch; neither happened in any of those 350 published batches."""
    size = QUESTION_SUB_BATCH_SIZE[domain]
    floor = (QUESTION_SUB_BATCHES - 1) * size + 4
    short, special, gap_batches = 0, 0, []
    for b, batch in enumerate(questions[:QUESTION_BATCHES], 1):
        lines = batch["messages"][0]
        expected = instruction_line(plans[b - 1], b) if b <= len(plans) else None
        short_here, special_here = len(lines) < floor, len(lines) < 2 or lines[-2] != expected
        short, special = short + short_here, special + special_here
        if short_here or special_here:
            gap_batches.append(b)
    gap_batches += list(range(len(questions) + 1, QUESTION_BATCHES + 1)) + list(range(QUESTION_BATCHES + 1, len(questions) + 1))
    return {"batches": f"{len(questions)}/{QUESTION_BATCHES}", "gap_batches": gap_batches, "short": short,
            "special_missing": special, "min_messages": min((len(b["messages"][0]) for b in questions), default=0),
            "floor": floor}


def answer_batch_gaps(planned, batch):
    """One chat.pickle batch against the user messages it answers (main.py:1874-2082): main questions missing or out of
    order (a swallowed error before the first reply drops the question), user turns with no assistant reply right after
    (one after a follow-up), and messages with no text."""
    mains = [m.get("content") for m in batch if m.get("role") == "user" and m.get("question_type") == "main_question"]
    pending = iter(planned)
    matched = sum(1 for q in mains if q in pending)
    unanswered = sum(1 for j, m in enumerate(batch) if m.get("role") == "user"
                     and (j + 1 == len(batch) or batch[j + 1].get("role") != "assistant"))
    empty = sum(1 for m in batch if not (isinstance(m.get("content"), str) and m["content"].strip()))
    return {"dropped": len(planned) - matched, "unmatched": len(mains) - matched, "unanswered": unanswered, "empty": empty}


def answer_gaps(questions, chat):
    """chat.pickle against user_messages.pickle: one batch per question batch (main.py:2084-2090 drops a batch that lost
    more than five questions and stops), each batch intact, and how many leading batches are intact."""
    totals = {"dropped": 0, "unmatched": 0, "unanswered": 0, "empty": 0}
    gap_batches = []
    for b, (planned, batch) in enumerate(zip(questions, chat), 1):
        gaps = answer_batch_gaps(planned["messages"][0], batch)
        totals = {k: totals[k] + gaps[k] for k in totals}
        if any(gaps.values()):
            gap_batches.append(b)
    gap_batches += list(range(len(chat) + 1, len(questions) + 1)) + list(range(len(questions) + 1, len(chat) + 1))
    intact = gap_batches[0] - 1 if gap_batches else len(chat)
    return {"batches": f"{len(chat)}/{len(questions)}", "intact_batches": intact, "gap_batches": gap_batches,
            "missing": max(0, len(questions) - len(chat)), **totals}


def gap_fields(gaps):
    return {k: ",".join(map(str, v)) or "none" if isinstance(v, list) else v for k, v in gaps.items()}


def gap_text(gaps):
    return " ".join(f"{k}={v}" for k, v in gap_fields(gaps).items())


def check_gaps(out):
    """The question and answer gap checks over every conversation's finished steps in an existing mint: one line of
    counts, batch numbers and the checked file's sha256 per step, never text. Returns the number of steps with gaps."""
    root = Path(out).resolve() / "set" / "conversations"
    convs = checked = with_gaps = skipped = 0
    for conv in sorted(root.iterdir()) if root.exists() else []:
        if not (conv / "manifest.json").exists():
            continue
        manifest = read_json(conv / "manifest.json")
        convs += 1
        if manifest.get("mode") == "fake":
            skipped += 1
            continue
        beam_chat = conv / "beam" / "1"
        steps = manifest.get("steps", {})
        for step, rel in (("question", "user_messages.pickle"), ("answer", "chat.pickle")):
            entry = steps.get(f"{step}@1") or {}
            if entry.get("status") != "done":
                continue
            if step == "question":
                gaps = question_gaps(read_pickle(beam_chat / rel), read_pickle(beam_chat / "plan_new.pickle"), domain_of(conv))
            else:
                gaps = answer_gaps(read_pickle(beam_chat / "user_messages.pickle"), read_pickle(beam_chat / rel))
            digest = sha256_file(beam_chat / rel)
            checked += 1
            with_gaps += bool(gaps["gap_batches"])
            emit({"conv": conv.name, "step": step, "gaps": len(gaps["gap_batches"]), **gap_fields(gaps), "sha256": digest,
                  "recorded": "match" if entry.get("outputs", {}).get(f"beam/1/{rel}") == digest else "changed"})
    emit({"summary": "check-gaps", "conversations": convs, "steps_checked": checked, "steps_with_gaps": with_gaps,
          "fake_skipped": skipped})
    return with_gaps


# ---------------------------------------------------------------------------------------------------- steps


class Context:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.out).resolve()
        self.index = args.conv_index
        self.cid = f"c{self.index:03d}"
        self.mode = args.mode
        self.conv = self.out / "set" / "conversations" / self.cid
        self.beam_root = self.conv / "beam"
        self.beam_chat = self.beam_root / "1"
        self.beam_dir = Path(args.beam_dir).resolve()
        self.key = conversation_seed(read_seed(args.seed_file), self.index)
        self.manifest = Manifest(self.conv, self.cid, self.index, self.mode)
        self._beam = None

    def rel(self, path):
        return str(Path(path).relative_to(self.conv))

    def usage(self, step, attempt):
        return Usage(self.conv / "usage" / f"{step}@{attempt}.jsonl")

    def model(self, usage, temperature):
        """A model for RS1's own prompts (topic, rubric) and BEAM's answer slot."""
        return gemini_model(temperature, usage) if self.mode == "real" else StubModel(derive(self.key, "stub-model"), usage)

    def beam(self, usage):
        if self._beam is None:
            unmetered = self.mode == "real" and not os.environ.get("RS1_PROXY_READY")
            slot = UnmeteredSlot() if unmetered else self.model(usage, 0.0)
            self._beam = load_beam(self.beam_dir, slot)
            if isinstance(slot, StubModel):
                slot.bind_templates(self._beam.prompts)
        return self._beam

    def domain(self):
        return domain_of(self.conv)


def step_topic(ctx, attempt, usage):
    if ctx.args.topic_source == "public":
        match = [t for t in public_1m_topics(ctx.beam_dir) if int(t["id"]) == ctx.index]
        if not match:
            raise StepFailure(f"BEAM's public 1M topics have no id {ctx.index}")
        topic = {k: match[0][k] for k in ("category", "title", "theme", "subtopics")}
    else:
        weights = {}
        for t in public_1m_topics(ctx.beam_dir):
            weights[t["category"]] = weights.get(t["category"], 0) + 1
        n = seeded_int(ctx.key, "category") % sum(weights.values())
        for category in sorted(weights):
            n -= weights[category]
            if n < 0:
                break
        if ctx.mode == "fake":
            topic = fake_topic(ctx, attempt, category)
            usage.record("fake", 300, 120)
        else:
            facets = sorted(FACETS, key=lambda f: derive(ctx.key, f"facet/{attempt}/{f}"))[:3]
            avoid = "\n".join(f"- {t['title']}" for t in public_topics(ctx.beam_dir) if t["category"] == category)
            prompt = TOPIC_PROMPT.format(category=category, facets="; ".join(facets), avoid=avoid or "- (none)")
            reply = parse_json_object(ctx.model(usage, 1.0).invoke(prompt).content)
            topic = {**{k: reply.get(k) for k in ("title", "theme", "subtopics")}, "category": category}
    if not valid_topic(topic):
        raise StepFailure("the generated topic is missing a title, theme or subtopics")
    path = ctx.conv / "topic-attempts" / f"{attempt}.json"
    write_json(path, {**topic, "custody": CUSTODY_MARKER})
    return [path], {}


def step_topic_check(ctx, attempt, usage):
    """Accept the attempt's topic unless it duplicates a BEAM public topic (every tier) or an accepted RS1 topic: the
    same normalized title, word overlap (Jaccard) of at least 0.6, or embedding cosine of at least 0.85."""
    candidate = read_json(ctx.conv / "topic-attempts" / f"{attempt}.json")
    if ctx.args.topic_source != "public":
        others = public_topics(ctx.beam_dir)
        for conv in sorted((ctx.out / "set" / "conversations").iterdir()):
            if conv.name != ctx.cid and (conv / "topic.json").exists():
                others.append(read_json(conv / "topic.json"))
        words = set(normalize(topic_text(candidate)).split())
        reason = None
        for other in others:
            other_words = set(normalize(topic_text(other)).split())
            if normalize(other["title"]) == normalize(candidate["title"]):
                reason = "title"
            elif words and other_words and len(words & other_words) / len(words | other_words) >= TOPIC_JACCARD_MAX:
                reason = "words"
            if reason:
                break
        if reason is None:
            vectors = embed([topic_text(candidate)] + [topic_text(o) for o in others], ctx.mode, usage)
            if any(cosine(vectors[0], v) >= TOPIC_COSINE_MAX for v in vectors[1:]):
                reason = "embedding"
        if reason is not None:
            return [], {"verdict": "rejected", "reason": reason}
    topic = {"id": 1, **{k: candidate[k] for k in ("category", "title", "theme", "subtopics")}}
    write_json(ctx.conv / "topic.json", {**topic, "custody": CUSTODY_MARKER})
    write_json(ctx.beam_root / "topics.json", [topic])
    return [ctx.conv / "topic.json", ctx.beam_root / "topics.json"], {"verdict": "accepted"}


def beam_outputs(ctx, names):
    return [ctx.beam_chat / n for n in names if (ctx.beam_chat / n).exists()]


def step_plan(ctx, attempt, usage):
    if ctx.mode == "fake":
        ctx.beam_chat.mkdir(parents=True, exist_ok=True)
        (ctx.beam_chat / "plan_new.txt").write_text(fake_words(ctx.key, "plan", 400), encoding="utf-8")
        usage.record("fake", 4000, 3000)
        return [ctx.beam_chat / "plan_new.txt"], {}
    beam = ctx.beam(usage)
    seed_rngs(ctx.key)
    beam.run_pipeline.run_plans_generation(str(ctx.beam_root), CHAT_SIZE, 0)
    return beam_outputs(ctx, ["topic.json", "labels.txt", "main_spec.txt", "relationships.txt", "plan.pickle", "plan.txt",
                              "plan_new.pickle", "plan_new.txt"]), {}


def step_question(ctx, attempt, usage):
    if ctx.mode == "fake":
        (ctx.beam_chat / "user_messages.txt").write_text(fake_words(ctx.key, "questions", 600), encoding="utf-8")
        usage.record("fake", 9000, 6000)
        return [ctx.beam_chat / "user_messages.txt"], {}
    ctx.beam(usage).run_pipeline.run_question_generation(str(ctx.beam_root), CHAT_SIZE, 0)
    gaps = question_gaps(read_pickle(ctx.beam_chat / "user_messages.pickle"),
                         read_pickle(ctx.beam_chat / "plan_new.pickle"), ctx.domain())
    if gaps["gap_batches"]:
        raise StepFailure(f"the question step lost output to a swallowed error: {gap_text(gaps)}")
    return beam_outputs(ctx, ["user_messages.pickle", "user_messages.txt"]), {}


def step_answer(ctx, attempt, usage):
    """BEAM's answer_generation (main.py:1775), one batch per call. Each call resumes from chat.pickle as BEAM's own
    resume does (main.py:1799-1804) and gets the user messages up to the next batch only, so it answers that batch and
    stops. A batch that fails the gap check, or during which any model call raised, is cut from chat.pickle and the step
    fails, so a rerun regenerates that batch and keeps every batch before it, and no batch is answered after a damaged
    one. BEAM's answer step retries no call, so every error it swallowed lost something, even where the output shows no
    gap: a follow-up whose user turn or yes/no check failed, or a summary that fell back to a placeholder."""
    if ctx.mode == "fake":
        write_json(ctx.beam_chat / "chat_raw.json", fake_chat(ctx.key))
        usage.record("fake", 90000, 60000)
        return [ctx.beam_chat / "chat_raw.json"], {}
    beam = ctx.beam(usage)
    chat_path, partial = ctx.beam_chat / "chat.pickle", ctx.beam_chat / "answer-input.pickle"
    questions = read_pickle(ctx.beam_chat / "user_messages.pickle")
    chat = read_pickle(chat_path) if chat_path.exists() else []
    intact = answer_gaps(questions, chat)["intact_batches"]
    if intact < len(chat):
        chat = chat[:intact]
        write_pickle(chat_path, chat)
    # BEAM's run_answer_generation (run_pipeline.py:264-273) builds topic and theme this way, and its run_pipeline.py
    # builds the answer model at temperature 0.1.
    topic = read_json(ctx.beam_chat / "topic.json")
    model = ctx.model(usage, 0.1)
    try:
        for b in range(intact, len(questions)):
            write_pickle(partial, questions[:b + 1])
            errors = usage.errors
            beam.main.answer_generation(input_address=str(partial), output_address=str(chat_path),
                                        plans_address=str(ctx.beam_chat / "plan_new.pickle"),
                                        topic=f"{topic['category']} -> {topic['title']}",
                                        theme=f"{topic['theme']} -> {', '.join(topic['subtopics'])}", llm=model)
            chat = read_pickle(chat_path)
            gaps = {**answer_gaps(questions[:b + 1], chat), "model_errors": usage.errors - errors}
            if gaps["gap_batches"] or gaps["model_errors"]:
                write_pickle(chat_path, chat[:b])
                raise StepFailure(f"answer batch {b + 1} of {len(questions)} lost output to a swallowed error: "
                                  f"{gap_text(gaps)}; chat.pickle is cut back to {b} intact batches")
    finally:
        partial.unlink(missing_ok=True)
    # Each call numbers its messages from 0 (main.py:1797) and add_ids_to_chats keeps those ids (utils.py:283-292), so
    # they are renumbered in chat order, as one uninterrupted run numbers them.
    for i, message in enumerate(message for batch in chat for message in batch):
        message["id"] = i
    write_pickle(chat_path, chat)
    return [chat_path], {}


def step_chat_json(ctx, attempt, usage):
    if ctx.mode == "fake":
        shutil.copyfile(ctx.beam_chat / "chat_raw.json", ctx.beam_chat / "chat.json")
        return [ctx.beam_chat / "chat.json"], {}
    beam = ctx.beam(usage)
    plain = ctx.beam_chat / "chat_without_ids.json"
    beam.utils.convert_chats_pickle_to_json(str(ctx.beam_chat / "chat.pickle"), str(plain))
    beam.utils.add_ids_to_chats(str(plain), str(ctx.beam_chat / "chat.json"))
    plain.unlink()
    return [ctx.beam_chat / "chat.json"], {}


def step_truncate(ctx, attempt, usage):
    if ctx.mode == "fake":
        return [], {"truncated": False}
    ctx.beam(usage).adjust.count_chats_tokens(str(ctx.beam_chat), GEN_MODEL, TRUNCATE_TOKENS)
    outputs = beam_outputs(ctx, ["chat_trunecated.json", "chat_trunecated.pickle", "plan_new_trunecated.pickle",
                                 "plan_new_trunecated.txt"])
    return outputs, {"truncated": bool(outputs)}


def step_probe_part(ctx, ability, usage):
    """One ability's candidate questions from BEAM's own generator (abstention from the plan, the rest from the plan's
    bullets and the turns they produced), reading the truncated chat and plan when they exist, as BEAM does."""
    path = candidate_file(ctx.beam_chat, ability)
    if ctx.mode == "fake":
        write_json(path, fake_candidates(ctx.key, ability))
        usage.record("fake", 20000, 2000)
        return [path]
    beam = ctx.beam(usage)
    plan = ctx.beam_chat / ("plan_new_trunecated.pickle" if (ctx.beam_chat / "plan_new_trunecated.pickle").exists() else "plan_new.pickle")
    chat = chat_file(ctx)
    if ability == "abstention":
        response = beam.main.generate_probing_questions(chat_address=str(chat), indexes=[], bullets=[],
                                                        probing_question_type="abstention", llm_name="gpt",
                                                        plan_address=str(plan), domain=ctx.domain())
        write_json(path, [response])
    else:
        beam.main.generate_probing_questions_candidate(plan_address=str(plan), probing_question_type=ability,
                                                       llm_name="gpt", chat_address=str(chat),
                                                       save_address=str(ctx.beam_chat), file_name=ability,
                                                       domain=ctx.domain())
    if not path.exists():
        raise StepFailure(f"BEAM wrote no {ability} candidates")
    return [path]


def chat_file(ctx):
    """The chat BEAM's later steps and validate.ts read: the truncated chat when truncation wrote one."""
    return ctx.beam_chat / ("chat_trunecated.json" if (ctx.beam_chat / "chat_trunecated.json").exists() else "chat.json")


def failed_slots(ctx, attempt):
    """Slots the validation report failed, or None when it asks for no regeneration of this conversation or a resumed
    run already regenerated the selection it read. A real mint takes only a report both paid validators wrote, and
    every mode refuses a report that read another chat than this conversation's."""
    if not ctx.args.regenerate:
        return None
    report = read_json(ctx.args.regenerate)
    conv = report.get("conversations", {}).get(ctx.cid)
    if not conv or conv.get("status") != "regenerate" or conv.get("select_attempt") == attempt - 2:
        return None
    if ctx.mode == "real" and report.get("validators") != PAID_VALIDATORS:
        raise StepFailure("a real mint regenerates only from a report the two paid validators wrote")
    if conv.get("chat_sha256") != sha256_file(chat_file(ctx)):
        raise StepFailure("the validation report read another chat than this conversation's")
    if conv.get("select_attempt") != attempt - 1:
        raise StepFailure(f"the validation report read selection attempt {conv.get('select_attempt')}, not {attempt - 1}")
    return {slot for slot, item in conv["items"].items() if not item["pass"]}


def step_select(ctx, attempt, usage):
    """Two items per ability, in an order fixed by the conversation seed. A regeneration keeps every item that passed
    validation and replaces each failed one with the next unused candidate; a failed candidate is never chosen again for
    its ability. Every ability's candidate file uses the same index keys, so a rejection is an (ability, key) pair."""
    previous = read_json(ctx.conv / "selection" / f"{attempt - 1}.json") if attempt > 1 else {"slots": {}, "failed": []}
    failed = failed_slots(ctx, attempt) or set() if attempt > 1 else set()
    if any("/" not in f for f in previous["failed"]):
        raise StepFailure(f"selection {attempt - 1} records rejections without their ability (an older format)")
    rejected = {tuple(f.split("/", 1)) for f in previous["failed"]}
    rejected |= {(s.split("#")[0], previous["slots"][s]) for s in failed if previous["slots"].get(s)}
    slots = {}
    for ability in ABILITIES:
        path = candidate_file(ctx.beam_chat, ability)
        pool = [(key, item) for key, item in flatten_candidates(read_json(path)) if usable(ability, item)] if path.exists() else []
        pool.sort(key=lambda kv: derive(ctx.key, f"select/{ability}/{kv[0]}"))
        question = dict((key, normalize(item["question"])) for key, item in pool)
        names = [f"{ability}#{n}" for n in range(ITEMS_PER_ABILITY)]
        kept = {s: previous["slots"][s] for s in names if previous["slots"].get(s) and s not in failed}
        taken = set(kept.values())
        for s in names:
            if s in kept:
                slots[s] = kept[s]
                continue
            seen = {question.get(k) for k in taken}
            slots[s] = next((k for k, _ in pool if k not in taken and (ability, k) not in rejected and question[k] not in seen), None)
            if slots[s] is not None:
                taken.add(slots[s])
    path = ctx.conv / "selection" / f"{attempt}.json"
    write_json(path, {"attempt": attempt, "slots": slots, "failed": sorted(f"{a}/{k}" for a, k in rejected)})
    return [path], {"empty_slots": sum(1 for v in slots.values() if v is None)}


def rubric_for(ctx, ability, item, usage):
    if ctx.mode == "fake":
        usage.record("fake", 400, 60)
        answer = item[ANSWER_FIELD[ability]]
        return [answer] if ability == "abstention" else [f"LLM response should state: {answer}"]
    prompt = RUBRIC_PROMPT.format(ability=ability, question=item["question"], answer=item[ANSWER_FIELD[ability]],
                                  rule=RUBRIC_RULES[ability])
    rubric = parse_json_object(ctx.model(usage, 0.0).invoke(prompt).content).get("rubric")
    if not (isinstance(rubric, list) and rubric and all(isinstance(r, str) and r.strip() for r in rubric)):
        raise StepFailure("the rubric reply is not a non-empty list of strings")
    return rubric


def step_rubric_part(ctx, attempt, slot, key, usage):
    """One selected item in BEAM's final probing-question format: the candidate's fields plus a rubric. An item kept
    from the previous attempt reuses that attempt's rubric without a model call."""
    path = ctx.conv / "rubric" / str(attempt) / f"{slot}.json"
    prior = ctx.conv / "rubric" / str(attempt - 1) / f"{slot}.json"
    if attempt > 1 and prior.exists() and read_json(prior)["candidate"] == key:
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(prior, path)
        return [path]
    ability = slot.split("#")[0]
    item = dict(flatten_candidates(read_json(candidate_file(ctx.beam_chat, ability))))[key]
    write_json(path, {"candidate": key, "item": {**item, "rubric": rubric_for(ctx, ability, item, usage)}, "custody": CUSTODY_MARKER})
    return [path]


def finish_rubric(ctx, attempt):
    slots = read_json(ctx.conv / "selection" / f"{attempt}.json")["slots"]
    questions = {a: [] for a in ABILITIES}
    for ability in ABILITIES:
        for n in range(ITEMS_PER_ABILITY):
            slot = f"{ability}#{n}"
            if slots.get(slot) is not None:
                item = read_json(ctx.conv / "rubric" / str(attempt) / f"{slot}.json")["item"]
                questions[ability].append({**item, "custody": CUSTODY_MARKER})
    path = ctx.beam_chat / "probing_questions" / "attempts" / f"{attempt}.json"
    write_json(path, questions)
    return [path]


def publish_questions(ctx):
    """probing_questions.json is a copy of the latest finished rubric attempt, so BEAM's loaders read the set as is."""
    latest = ctx.manifest.latest("rubric")
    if not latest or not ctx.manifest.done("rubric", latest):
        return
    src = ctx.beam_chat / "probing_questions" / "attempts" / f"{latest}.json"
    dst = ctx.beam_chat / "probing_questions" / "probing_questions.json"
    if not dst.exists() or sha256_file(dst) != sha256_file(src):
        shutil.copyfile(src, dst)


SIMPLE = {"plan": step_plan, "question": step_question, "answer": step_answer, "chat_json": step_chat_json,
          "truncate": step_truncate}


def run_step(ctx, step):
    """Returns (status, attempt, outputs, usage, exit code)."""
    m = ctx.manifest
    if step == "topic":
        if m.accepted_topic():
            return finished(ctx, "topic", m.accepted_topic(), "skipped")
        attempt = len(m.attempts("topic_check")) + 1
        if attempt > TOPIC_ATTEMPTS:
            return finished(ctx, "topic", attempt - 1, "dropped", code=11)
        if m.done("topic", attempt):
            return finished(ctx, "topic", attempt, "skipped")
        return execute(ctx, "topic", attempt, lambda u: step_topic(ctx, attempt, u))
    if step == "topic_check":
        attempt = m.latest("topic")
        if attempt == 0:
            raise StepFailure("topic_check needs a finished topic attempt")
        if m.done("topic_check", attempt):
            result = finished(ctx, "topic_check", attempt, "skipped")
        else:
            result = execute(ctx, "topic_check", attempt, lambda u: step_topic_check(ctx, attempt, u))
        if m.entry("topic_check", attempt)["verdict"] == "accepted":
            return result
        status, _, outputs, usage, _ = result
        return ("dropped", attempt, outputs, usage, 11) if attempt >= TOPIC_ATTEMPTS else ("rejected", attempt, outputs, usage, 10)
    if not m.accepted_topic():
        raise StepFailure(f"{step} needs an accepted topic")
    if step == "select":
        attempt = max(1, m.latest("select"))
        if m.done("select", attempt) and failed_slots(ctx, attempt + 1) is not None:
            if attempt >= SELECT_ATTEMPTS:
                return finished(ctx, "select", attempt, "exhausted", code=12)
            attempt += 1
        if m.done("select", attempt):
            return finished(ctx, "select", attempt, "skipped")
        return execute(ctx, "select", attempt, lambda u: step_select(ctx, attempt, u))
    if step == "rubric":
        attempt = m.latest("select")
        if attempt == 0:
            raise StepFailure("rubric needs a finished selection")
        if m.done("rubric", attempt):
            result = finished(ctx, "rubric", attempt, "skipped")
        else:
            slots = read_json(ctx.conv / "selection" / f"{attempt}.json")["slots"]
            parts = {s: (lambda u, s=s, k=k: step_rubric_part(ctx, attempt, s, k, u)) for s, k in slots.items() if k is not None}
            result = execute_parts(ctx, "rubric", attempt, parts, lambda: finish_rubric(ctx, attempt))
        publish_questions(ctx)
        return result
    if step == "probe":
        if m.done("probe", 1):
            return finished(ctx, "probe", 1, "skipped")
        parts = {a: (lambda u, a=a: step_probe_part(ctx, a, u)) for a in ABILITIES}
        return execute_parts(ctx, "probe", 1, parts, lambda: [])
    if m.done(step, 1):
        return finished(ctx, step, 1, "skipped")
    return execute(ctx, step, 1, lambda u: SIMPLE[step](ctx, 1, u))


def finished(ctx, step, attempt, status, code=0):
    entry = ctx.manifest.entry(step, attempt) or {}
    outputs = ctx.manifest.verify(step, attempt) if entry else {}
    return status, attempt, outputs, entry.get("usage", {}), code


def execute(ctx, step, attempt, fn):
    usage = ctx.usage(step, attempt)
    with quiet():
        paths, extra = fn(usage)
    entry = {"status": "done", "outputs": ctx.manifest.hashes(ctx.rel(p) for p in paths), "usage": usage.totals(), **extra}
    ctx.manifest.save(step, attempt, entry)
    return "done", attempt, entry["outputs"], entry["usage"], 0


class PartFailure(Exception):
    def __init__(self, step, errors):
        super().__init__(f"{len(errors)} of the {step} parts failed")
        self.errors = errors


def execute_parts(ctx, step, attempt, parts, finish):
    """A step made of independent parts (one per ability or item). A part that finished is recorded at once and never
    run again, so a resumed step re-samples nothing it already recorded."""
    from concurrent.futures import ThreadPoolExecutor

    m = ctx.manifest
    entry = m.entry(step, attempt) or {"status": "running", "parts": {}}
    for name, part in entry["parts"].items():
        for rel, digest in part["outputs"].items():
            if not (ctx.conv / rel).is_file() or sha256_file(ctx.conv / rel) != digest:
                raise StepFailure(f"{step}@{attempt} part {name} is recorded but {rel} is missing or changed")
    usage = ctx.usage(step, attempt)
    errors = []

    def one(name):
        try:
            paths = parts[name](usage)
            with m.lock:
                entry["parts"][name] = {"outputs": {ctx.rel(p): sha256_file(p) for p in paths}}
                m.data["steps"][f"{step}@{attempt}"] = entry
                write_json(m.path, m.data)
        except BaseException as error:
            errors.append((name, error, traceback.format_exc()))

    with quiet():
        todo = [n for n in parts if n not in entry["parts"]]
        with ThreadPoolExecutor(max_workers=1 if ctx.mode == "fake" else 8) as pool:
            list(pool.map(one, todo))
        if errors:
            raise PartFailure(step, errors)
        paths = finish()
    entry.update({"status": "done", "outputs": m.hashes(ctx.rel(p) for p in paths), "usage": usage.totals()})
    m.save(step, attempt, entry)
    return "done", attempt, m.verify(step, attempt), entry["usage"], 0


SAVED_OUT = os.dup(1)
SAVED_ERR = os.dup(2)


class quiet:
    """Point file descriptors 1 and 2 at /dev/null while BEAM runs; the driver's own line goes to a saved copy."""

    def __enter__(self):
        sys.stdout.flush()
        sys.stderr.flush()
        self.null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(self.null, 1)
        os.dup2(self.null, 2)

    def __exit__(self, *exc):
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(SAVED_OUT, 1)
        os.dup2(SAVED_ERR, 2)
        os.close(self.null)
        return False


def emit(fields):
    os.write(SAVED_OUT, ("rs1-mint " + " ".join(f"{k}={v}" for k, v in fields.items()) + "\n").encode("ascii"))


def outputs_digest(outputs):
    return sha256_bytes("".join(f"{d}  {r}\n" for r, d in sorted(outputs.items())).encode("utf-8"))


# ---------------------------------------------------------------------------------------------------- usage summary


def usage_summary(out):
    """Counts-only usage per conversation and step: model calls, tokens and replies stopped at their output limit
    ('capped') from the driver, requests and dollars from the metering proxy's request logs (real mode). Written to
    <out>/usage.json for stage 0's mint-cost measurement."""
    out = Path(out).resolve()
    keys = ("calls", "input_tokens", "output_tokens", "capped", "metered_requests", "metered_usd")
    convs, by_step, totals = {}, {}, dict.fromkeys(keys, 0)
    root = out / "set" / "conversations"
    for conv in sorted(root.iterdir()) if root.exists() else []:
        if not (conv / "manifest.json").exists():
            continue
        steps = {}
        for f in sorted((conv / "usage").glob("*.jsonl")):
            s = steps.setdefault(f.stem.split("@")[0], dict.fromkeys(keys, 0))
            for k, v in Usage(f).totals().items():
                s[k] += v
        for f in sorted((out / "proxy" / "requests").glob(f"{conv.name}-*.jsonl")):
            s = steps.setdefault(f.stem[len(conv.name) + 1:], dict.fromkeys(keys, 0))
            for line in f.read_text(encoding="utf-8").splitlines():
                s["metered_requests"] += 1
                s["metered_usd"] += float(json.loads(line).get("actual_usd") or 0)
        for step, s in steps.items():
            b = by_step.setdefault(step, dict.fromkeys(keys, 0))
            for k in keys:
                s[k] = round(s[k], 6)
                b[k] = round(b[k] + s[k], 6)
                totals[k] = round(totals[k] + s[k], 6)
        m = read_json(conv / "manifest.json")["steps"]
        latest = max((int(k.split("@")[1]) for k in m if k.startswith("rubric@")), default=0)
        checks = [e for k, e in m.items() if k.startswith("topic_check@")]
        if latest and m[f"rubric@{latest}"].get("status") == "done":
            status = "complete"
        elif len(checks) >= TOPIC_ATTEMPTS and not any(e.get("verdict") == "accepted" for e in checks):
            status = "dropped"
        else:
            status = "incomplete"
        convs[conv.name] = {"status": status, "steps": steps}
    summary = {"schema": "rs1-usage/v1", "beam_commit": BEAM_COMMIT, "conversations": convs, "steps": by_step, "totals": totals}
    write_json(out / "usage.json", summary)
    counts = {s: sum(1 for c in convs.values() if c["status"] == s) for s in ("complete", "incomplete", "dropped")}
    return summary, counts, sha256_file(out / "usage.json")


# ---------------------------------------------------------------------------------------------------- CLI


def main(argv):
    parser = argparse.ArgumentParser(prog="rs1_mint.py")
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("step")
    s.add_argument("--out", required=True)
    s.add_argument("--conv-index", type=int, required=True)
    s.add_argument("--step", choices=list(STEPS), required=True)
    s.add_argument("--seed-file", required=True)
    s.add_argument("--mode", choices=["fake", "stub-model", "real"], required=True)
    s.add_argument("--beam-dir", required=True)
    s.add_argument("--topic-source", choices=["seeded", "public"], default="seeded")
    s.add_argument("--regenerate")
    c = sub.add_parser("check-seed")
    c.add_argument("--seed-file", required=True)
    u = sub.add_parser("usage")
    u.add_argument("--out", required=True)
    g = sub.add_parser("check-gaps")
    g.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    if args.command == "check-seed":
        try:
            read_seed(args.seed_file)
        except (StepFailure, OSError) as error:
            os.write(SAVED_ERR, f"rs1-mint refused: {error if isinstance(error, StepFailure) else type(error).__name__}\n".encode("utf-8"))
            return 1
        emit({"seed": "ok"})
        return 0
    if args.command == "usage":
        summary, counts, digest = usage_summary(args.out)
        t = summary["totals"]
        emit({"summary": "usage", **counts, "calls": t["calls"], "input_tokens": t["input_tokens"],
              "output_tokens": t["output_tokens"], "capped": t["capped"], "metered_requests": t["metered_requests"],
              "metered_usd": f"{t['metered_usd']:.6f}", "usage_sha256": digest})
        return 0
    if args.command == "check-gaps":
        return 1 if check_gaps(args.out) else 0

    cid = f"c{args.conv_index:03d}"
    ctx = None
    try:
        ctx = Context(args)
        status, attempt, outputs, usage, code = run_step(ctx, args.step)
        emit({"conv": cid, "step": args.step, "status": status, "attempt": attempt, "outputs": len(outputs),
              "calls": usage.get("calls", 0), "input_tokens": usage.get("input_tokens", 0),
              "output_tokens": usage.get("output_tokens", 0), "capped": usage.get("capped", 0),
              "outputs_sha256": outputs_digest(outputs)})
        return code
    except BaseException as error:
        detail = traceback.format_exc()
        if isinstance(error, PartFailure):
            detail += "".join(f"\n--- part {name}\n{tb}" for name, _, tb in error.errors)
        if ctx is not None:
            path = ctx.conv / "errors" / f"{args.step}.traceback"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(detail, encoding="utf-8")
        emit({"conv": cid, "step": args.step, "status": "error", "error_class": type(error).__name__,
              "error_sha256": sha256_bytes(str(error).encode("utf-8"))[:16]})
        if isinstance(error, (StepFailure, ProviderRefusal)):
            os.write(SAVED_ERR, f"rs1-mint refused: {error}\n".encode("utf-8"))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
