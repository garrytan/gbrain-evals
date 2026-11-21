/**
 * RS1 custody scripts (GST-1154, GBEV-36): the answer step stops generating batches once the chat has passed BEAM's
 * truncation limit. Keyless: BEAM's answer, chat_json and truncate code are stubs with BEAM's control flow and file
 * shapes (every turn counts a fixed number of tokens), nothing reaches a provider, and every message holds a marker
 * word, so any text that reaches stdout or stderr shows. The last block runs the same stop against BEAM's own code where
 * a BEAM checkout and venv exist.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConversation } from '../../eval/custody/rs1/validate.ts';

const REPO = resolve(import.meta.dir, '../..');
const RS1 = join(REPO, 'eval/custody/rs1');
const SECRET = 'sealedtext';
const seedLine = (name: string) => ['rs1', 'seed', 'v1'].join('-') + ':' + createHash('sha256').update(name).digest('hex');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Runs one harness scenario in a fresh directory: its RESULT line, and every other line it printed. */
function scenario(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rs1-early-stop-'));
  roots.push(dir);
  writeFileSync(join(dir, 'k.rs1-seed'), seedLine('early stop test ' + name) + '\n', { mode: 0o600 });
  const r = run('python3', ['-c', HARNESS, RS1, name, dir, join(dir, 'k.rs1-seed')]);
  const lines = r.out.split('\n').filter(Boolean);
  const result = lines.find(l => l.startsWith('RESULT '));
  if (!result) throw new Error(`scenario ${name} printed no RESULT (exit ${r.code})`);
  return { result: JSON.parse(result.slice(7)), out: lines.filter(l => !l.startsWith('RESULT ')), err: r.err };
}

const HARNESS = String.raw`import json, os, sys, types
from pathlib import Path

rs1_dir, scenario, root, seed_file = sys.argv[1:5]
sys.path.insert(0, rs1_dir)
import rs1_mint as m

SECRET = "sealedtext"
B, Q = 10, 8
# Tokens per turn: 80 turns of 20,000 pass 1,040,000 at turn 53 (batch 7, turn 5); 80 of 12,000 never do.
TOKENS = {"stop": 20000, "never": 12000}[scenario]
seen = {"prompted": set(), "counts": []}


def plan_text(b):
    return "BATCH %d PLAN\n" % b + "\n".join("\u2022 **Point %d:** %s point %d-%d" % (k, SECRET, b, k) for k in range(1, Q + 3))


def questions():
    return [{"time_anchor": "March-%02d-2024" % b,
             "messages": [["%s question %d-%d ->-> %d,%d" % (SECRET, b, i, b, i + 2) for i in range(Q)]]} for b in range(1, B + 1)]


def answer_generation(input_address, output_address, plans_address, topic, theme, llm):
    """BEAM's answer_generation (src/beam/main.py:1775-2093) cut down to the messages it writes: it resumes after the
    batches in chat.pickle and numbers messages from 0."""
    batches = m.read_pickle(input_address)
    chat = m.read_pickle(output_address) if os.path.isfile(output_address) else []
    n = 0
    for b, batch in enumerate(batches[len(chat):], start=len(chat) + 1):
        seen["prompted"].add(b)
        history = []
        for i, question in enumerate(batch["messages"][0]):
            user = {"role": "user", "id": n, "index": question.split("->->")[1].strip(), "question_type": "main_question",
                    "content": question}
            if i == 0:
                user["time_anchor"] = batch["time_anchor"]
            history += [user, {"role": "assistant", "id": n + 1, "content": SECRET + " reply to " + question}]
            n += 2
        chat.append(history)
    m.write_pickle(output_address, chat)


def convert_chats_pickle_to_json(input_address, output_address):
    """BEAM's convert_chats_pickle_to_json (src/beam/utils.py:195): a turn starts at each main question."""
    out = []
    for b, batch in enumerate(m.read_pickle(input_address), 1):
        turns = []
        for message in batch:
            if message.get("question_type") == "main_question" or not turns:
                turns.append([])
            turns[-1].append(message)
        out.append({"batch_number": b, "turns": turns, "time_anchor": None})
    m.write_json(output_address, out)


def add_ids_to_chats(input_address, output_address):
    m.write_json(output_address, m.read_json(input_address))


def count_chats_tokens(chat_directory, model_name, token_limit):
    """BEAM's count_chats_tokens (src/beam/adjust_chats_length.py:62) with every turn counted as TOKENS: the turns before
    the one that takes the running count past token_limit go to chat_trunecated.json, and it prints each turn and the
    count."""
    seen["counts"].append([model_name, token_limit])
    kept, total = [], 0
    for b, batch in enumerate(m.read_json(Path(chat_directory) / "chat.json")):
        for t, turn in enumerate(batch["turns"]):
            print("Batch Number: %d, Turn Number: %d" % (b, t))
            total += TOKENS
            if total > token_limit:
                if t:
                    kept.append({"batch_number": b + 1, "turns": batch["turns"][:t], "time_anchor": batch["time_anchor"]})
                m.write_json(Path(chat_directory) / "chat_trunecated.json", kept)
                print(total)
                return
        kept.append(batch)
    print(total)


m.load_beam = lambda beam_dir, slot: types.SimpleNamespace(
    main=types.SimpleNamespace(answer_generation=answer_generation),
    utils=types.SimpleNamespace(convert_chats_pickle_to_json=convert_chats_pickle_to_json, add_ids_to_chats=add_ids_to_chats),
    adjust=types.SimpleNamespace(count_chats_tokens=count_chats_tokens))
m.gemini_model = lambda temperature, usage: None

out = Path(root) / "rs1-custody-early-stop"
conv = out / "set" / "conversations" / "c001"
beam_chat = conv / "beam" / "1"
beam_chat.mkdir(parents=True)
topic = {"id": 1, "category": "Travel", "title": SECRET + " title", "theme": SECRET + " theme", "subtopics": ["a", "b", "c"]}
m.write_json(conv / "topic.json", topic)
m.write_json(beam_chat / "topic.json", topic)
m.write_pickle(beam_chat / "plan_new.pickle", [plan_text(b) for b in range(1, B + 1)])
m.write_pickle(beam_chat / "user_messages.pickle", questions())
m.write_json(conv / "manifest.json", {"schema": "rs1-mint-manifest/v1", "conversation": "c001", "index": 1, "mode": "real",
                                      "beam_commit": m.BEAM_COMMIT,
                                      "steps": {"topic_check@1": {"status": "done", "verdict": "accepted", "outputs": {}}}})


def window_args(out):
    import sqlite3
    path = str(out) + "-window.sqlite"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS caps (seq INTEGER PRIMARY KEY AUTOINCREMENT, program_cap_usd REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, budget_usd REAL NOT NULL, finished_at TEXT)")
    db.execute("INSERT OR IGNORE INTO runs VALUES ('rs1-test', 1, NULL)")
    if not db.execute("SELECT COUNT(*) FROM caps").fetchone()[0]:
        db.execute("INSERT INTO caps (program_cap_usd) VALUES (1)")
    db.commit()
    db.close()
    return ["--paid-window", "RS1-TEST", "--window-cap-usd", "1", "--budget-ledger", path, "--budget-run-id", "rs1-test"]


def step(name):
    seen["prompted"].clear()
    code = m.main(["step", "--out", str(out), "--conv-index", "1", "--step", name, "--seed-file", seed_file, "--mode", "real",
                   "--beam-dir", str(out)] + window_args(out))
    entry = m.read_json(conv / "manifest.json")["steps"].get(name + "@1", {})
    chat = m.read_pickle(beam_chat / "chat.pickle")
    return {"code": code, "prompted": sorted(seen["prompted"]), "batches": len(chat), "status": entry.get("status"),
            "early_stop": entry.get("early_stop"), "ids_in_order": [x["id"] for b in chat for x in b] == list(range(sum(map(len, chat))))}


first = step("answer")
first["counts"] = sorted({tuple(c) for c in seen["counts"]})
first["left"] = sorted(p.name for p in conv.iterdir())
first["beam_files"] = sorted(p.name for p in beam_chat.iterdir())
rerun = step("answer")
# A run that wrote the stopping batch to chat.pickle and died before the manifest recorded the step.
manifest = m.read_json(conv / "manifest.json")
del manifest["steps"]["answer@1"]
m.write_json(conv / "manifest.json", manifest)
crashed = step("answer")
truncate = [step("chat_json")["code"], step("truncate")["code"]]
checks = {"mint": m.main(["check-early-stop", "--out", str(out), "--beam-dir", str(out)]),
          "empty": m.main(["check-early-stop", "--out", str(Path(root) / "no-mint"), "--beam-dir", str(out)])}
print("RESULT " + json.dumps({"out": str(out), "first": first, "rerun": rerun, "crashed": crashed, "truncate": truncate, "checks": checks}), flush=True)
`;

const STOP = {
  batches_answered: 7, batches_planned: 10, batch: 7, turn: 5, kept_batches: 7, kept_turns_in_last_batch: 4,
  beam_printed_tokens: 1_060_000, limit: 1_040_000,
};

describe('rs1_mint.py answer-step early stop at BEAM\'s truncation point (stubbed BEAM)', () => {
  let stop: ReturnType<typeof scenario> | undefined;
  const stopped = () => (stop ??= scenario('stop'));

  test('a chat that passes the limit inside batch 7 stops after batch 7 and records where BEAM\'s truncate cuts', () => {
    const s = stopped();
    expect(s.err).toBe('');
    expect(s.result.first).toEqual({
      code: 0, prompted: [1, 2, 3, 4, 5, 6, 7], batches: 7, status: 'done', early_stop: STOP, ids_in_order: true,
      counts: [['gemini-3.8-flash', 1_040_000]], left: ['beam', 'manifest.json', 'topic.json', 'usage'],
      beam_files: ['chat.pickle', 'plan_new.pickle', 'topic.json', 'user_messages.pickle'],
    });
    expect(s.out.join('\n')).not.toContain(SECRET);
  });

  test('a resume after the stop generates nothing, whether or not the manifest recorded the step', () => {
    const s = stopped();
    expect(s.result.rerun).toMatchObject({ code: 0, prompted: [], batches: 7, status: 'done', early_stop: STOP });
    expect(s.out.some(l => l.startsWith('rs1-mint conv=c001 step=answer status=skipped '))).toBe(true);
    expect(s.result.crashed).toEqual({ code: 0, prompted: [], batches: 7, status: 'done', early_stop: STOP, ids_in_order: true });
    expect(s.result.truncate).toEqual([0, 0]);
  });

  test('a chat that never passes the limit answers all 10 batches and records no stop', () => {
    const s = scenario('never');
    expect(s.err).toBe('');
    expect(s.result.first).toMatchObject({ code: 0, prompted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], batches: 10, status: 'done', early_stop: null, ids_in_order: true });
  });

  test('check-early-stop exits 3 (untested) when it checks no conversation or only early-stopped ones, and 0 on a fully answered mint', () => {
    const s = stopped();
    expect(s.result.checks).toEqual({ mint: 3, empty: 3 });
    expect(s.out).toContain('rs1-mint check=early-stop status=untested conversations=1 early_stopped=1 reason=all-early-stopped');
    expect(s.out).toContain('rs1-mint check=early-stop status=untested conversations=0 early_stopped=0 reason=no-finished-answer-step');
    const never = scenario('never');
    expect(never.result.checks).toEqual({ mint: 0, empty: 3 });
    expect(never.out).toContain('rs1-mint summary=check-early-stop conversations=1 files_differ=0');
    expect(never.out.join('\n') + never.err).not.toContain(SECRET);
  });

  test('check-gaps counts the batches answered before the stop as the whole answer step', () => {
    const r = run('python3', [join(RS1, 'rs1_mint.py'), 'check-gaps', '--out', stopped().result.out]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(SECRET);
    const lines = r.out.trim().split('\n');
    expect(lines[0]).toMatch(/^rs1-mint conv=c001 step=answer gaps=0 batches=7\/7 intact_batches=7 gap_batches=none missing=0 dropped=0 unmatched=0 unanswered=0 empty=0 early_stop=7 sha256=[0-9a-f]{64} recorded=match$/);
    expect(lines[1]).toBe('rs1-mint summary=check-gaps conversations=1 steps_checked=1 steps_with_gaps=0 fake_skipped=0');
  });

  test('validate.ts loads an early-stopped conversation as complete and reads its truncated chat', () => {
    const set = join(stopped().result.out, 'set');
    const conv = join(set, 'conversations', 'c001');
    const manifest = JSON.parse(readFileSync(join(conv, 'manifest.json'), 'utf8'));
    manifest.steps['select@1'] = { status: 'done', outputs: {} };
    manifest.steps['rubric@1'] = { status: 'done', outputs: {} };
    writeFileSync(join(conv, 'manifest.json'), JSON.stringify(manifest));
    mkdirSync(join(conv, 'selection'), { recursive: true });
    writeFileSync(join(conv, 'selection', '1.json'), JSON.stringify({ attempt: 1, slots: {}, failed: [] }));
    const loaded = loadConversation(set, 'c001');
    expect(loaded.complete).toBe(true);
    expect(loaded.chatSha256).toBe(sha256(join(conv, 'beam', '1', 'chat_trunecated.json')));
    expect(loaded.messages).toHaveLength((6 * 8 + 4) * 2);
  });
});

/**
 * The same early stop against BEAM's own chat_json and truncate code and its tokenizer, at the pinned commit. It needs
 * a BEAM checkout from eval/custody/rs1/beam-checkout.sh (RS1_BEAM_DIR) and the python of a venv built from
 * eval/custody/rs1/requirements.lock as mint.sh builds it (RS1_BEAM_PYTHON), which CI's test shards don't have, so there
 * it is skipped. TIKTOKEN_CACHE_DIR passes through. Each case builds an 80-turn chat whose turns BEAM's count puts at
 * about 20,000 tokens and places the turn that passes 1,040,000 as batch 7's first, last or fourth turn (the no-cut case
 * uses turns of about 11,000). Conversation c001 runs the answer step, which stops early, then chat_json and truncate;
 * c002 is the same chat answered in full in one uninterrupted BEAM-shaped call, then chat_json and truncate; then
 * check-early-stop replays c002.
 */
const BEAM_DIR = process.env.RS1_BEAM_DIR ?? '';
const BEAM_PYTHON = process.env.RS1_BEAM_PYTHON ?? '';
const HAVE_BEAM = !!BEAM_DIR && !!BEAM_PYTHON && existsSync(join(BEAM_DIR, 'src/beam/adjust_chats_length.py')) && existsSync(BEAM_PYTHON);
const NEEDS_BEAM = ' [skipped: needs a BEAM checkout and venv: RS1_BEAM_DIR from eval/custody/rs1/beam-checkout.sh, RS1_BEAM_PYTHON from a venv built from eval/custody/rs1/requirements.lock]';

function beamCase(edge: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rs1-early-stop-beam-'));
  roots.push(dir);
  writeFileSync(join(dir, 'k.rs1-seed'), seedLine('early stop beam ' + edge) + '\n', { mode: 0o600 });
  const cache = process.env.TIKTOKEN_CACHE_DIR ? { TIKTOKEN_CACHE_DIR: process.env.TIKTOKEN_CACHE_DIR } : {};
  const r = spawnSync(BEAM_PYTHON, ['-c', BEAM_HARNESS, RS1, BEAM_DIR, edge, dir, join(dir, 'k.rs1-seed')], {
    cwd: REPO, encoding: 'utf8', timeout: 300_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PYTHONDONTWRITEBYTECODE: '1', ...cache },
  });
  const lines = (r.stdout ?? '').split('\n').filter(Boolean);
  const result = lines.find(l => l.startsWith('RESULT '));
  if (!result) throw new Error(`case ${edge} printed no RESULT (exit ${r.status})`);
  return { result: JSON.parse(result.slice(7)), out: lines.filter(l => !l.startsWith('RESULT ')), err: r.stderr ?? '' };
}

const BEAM_HARNESS = String.raw`import hashlib, json, os, sys, types
from pathlib import Path

rs1_dir, beam_dir, edge, root, seed_file = sys.argv[1:6]
sys.path.insert(0, rs1_dir)
import rs1_mint as m

SECRET = "sealedtext"
B, N = 10, 80
prompted = set()


def words(label, n):
    out, i = [], 0
    while len(out) < n:
        digest = hashlib.sha256(("%s/%d" % (label, i)).encode()).hexdigest()
        out.extend(digest[j:j + 6] for j in range(0, 60, 6))
        i += 1
    return " ".join(out[:n])


def reply(question):
    return SECRET + " reply " + words("reply " + question.split()[1], len(question.split()))


def answer_generation(input_address, output_address, plans_address, topic, theme, llm):
    """BEAM's answer_generation (src/beam/main.py:1775-2093) cut down to the messages it writes, with a reply as long as
    the question: it resumes after the batches in chat.pickle and numbers messages from 0."""
    batches = m.read_pickle(input_address)
    chat = m.read_pickle(output_address) if os.path.isfile(output_address) else []
    n = 0
    for b, batch in enumerate(batches[len(chat):], start=len(chat) + 1):
        prompted.add(b)
        history = []
        for i, question in enumerate(batch["messages"][0]):
            user = {"role": "user", "id": n, "index": question.split("->->")[1].strip(), "question_type": "main_question",
                    "content": question}
            if i == 0:
                user["time_anchor"] = batch["time_anchor"]
            history += [user, {"role": "assistant", "id": n + 1, "content": reply(question)}]
            n += 2
        chat.append(history)
    m.write_pickle(output_address, chat)


real_load_beam = m.load_beam


def load_beam(path, slot):
    loaded = real_load_beam(path, slot)
    loaded.main = types.SimpleNamespace(answer_generation=answer_generation)
    return loaded


m.load_beam = load_beam
m.gemini_model = lambda temperature, usage: None
beam = real_load_beam(Path(beam_dir), m.UnmeteredSlot())
size = (lambda i: 1100 + i * 389 % 300) if edge == "none" else (lambda i: 2000 + i * 389 % 600)


def build(sizes):
    """Question i of the chat, in its batch at bullet k + 2, with size(i) words before its ->-> index."""
    out, i = [], 0
    for b, s in enumerate(sizes, 1):
        out.append(["%s q%d %s ->-> %d,%d" % (SECRET, i + k, words("q%d" % (i + k), size(i + k)), b, k + 2) for k in range(s)])
        i += s
    return out


def crossing(batches):
    """The chat-order index of the turn at which BEAM's count first passes the limit, for placing the fixture's edge."""
    total = 0
    for j, q in enumerate(q for batch in batches for q in batch):
        total += beam.adjust.count_message_tokens(messages=[{"role": "user", "content": q}, {"role": "assistant", "content": reply(q)}],
                                                  model_name=m.GEN_MODEL)
        if total > m.TRUNCATE_TOKENS:
            return j
    return None


split = lambda total, k: [total // k + (j < total % k) for j in range(k)]
sizes = [N // B] * B
batches = build(sizes)
c = crossing(batches)
if edge != "none":
    # The crossing turn placed as batch 7's first, last or fourth turn. Its ->-> index changes a turn's count by a token
    # or so, so the placement is rebuilt until the crossing turn stays put.
    for _ in range(4):
        before = {"first": c, "last": c - 7, "mid": c - 3}[edge]
        sizes = split(before, 6) + [8] + split(N - before - 8, 3)
        batches = build(sizes)
        if crossing(batches) == c:
            break
        c = crossing(batches)
    else:
        raise SystemExit("the fixture's crossing turn did not settle")
elif c is not None:
    raise SystemExit("the no-cut fixture passes the limit")

out = Path(root) / "rs1-custody-beam"
plans = ["BATCH %d PLAN\n" % b + "\n".join("\u2022 **Point %d:** %s point %d-%d" % (k, SECRET, b, k) for k in range(1, max(sizes) + 3))
         for b in range(1, B + 1)]
questions = [{"time_anchor": "March-%02d-2024" % b, "messages": [batch]} for b, batch in enumerate(batches, 1)]
for index in (1, 2):
    conv = out / "set" / "conversations" / ("c%03d" % index)
    (conv / "beam" / "1").mkdir(parents=True)
    topic = {"id": 1, "category": "Travel", "title": SECRET + " title", "theme": SECRET + " theme", "subtopics": ["a", "b", "c"]}
    m.write_json(conv / "topic.json", topic)
    m.write_json(conv / "beam" / "1" / "topic.json", topic)
    m.write_pickle(conv / "beam" / "1" / "plan_new.pickle", plans)
    m.write_pickle(conv / "beam" / "1" / "user_messages.pickle", questions)
    m.write_json(conv / "manifest.json", {"schema": "rs1-mint-manifest/v1", "conversation": conv.name, "index": index, "mode": "real",
                                          "beam_commit": m.BEAM_COMMIT,
                                          "steps": {"topic_check@1": {"status": "done", "verdict": "accepted", "outputs": {}}}})
early, full = (out / "set" / "conversations" / c / "beam" / "1" for c in ("c001", "c002"))


def window_args(out):
    import sqlite3
    path = str(out) + "-window.sqlite"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS caps (seq INTEGER PRIMARY KEY AUTOINCREMENT, program_cap_usd REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, budget_usd REAL NOT NULL, finished_at TEXT)")
    db.execute("INSERT OR IGNORE INTO runs VALUES ('rs1-test', 1, NULL)")
    if not db.execute("SELECT COUNT(*) FROM caps").fetchone()[0]:
        db.execute("INSERT INTO caps (program_cap_usd) VALUES (1)")
    db.commit()
    db.close()
    return ["--paid-window", "RS1-TEST", "--window-cap-usd", "1", "--budget-ledger", path, "--budget-run-id", "rs1-test"]


def step(index, name):
    return m.main(["step", "--out", str(out), "--conv-index", str(index), "--step", name, "--seed-file", seed_file,
                   "--mode", "real", "--beam-dir", beam_dir] + window_args(out))


# c001 runs the answer step, which stops early; c002 is the same chat answered in full, in one uninterrupted call.
codes = [step(1, "answer"), step(1, "chat_json"), step(1, "truncate")]
answered = sorted(prompted)
answer_generation(str(full / "user_messages.pickle"), str(full / "chat.pickle"), None, None, None, None)
manifest = m.read_json(out / "set" / "conversations" / "c002" / "manifest.json")
manifest["steps"]["answer@1"] = {"status": "done", "outputs": {"beam/1/chat.pickle": m.sha256_file(full / "chat.pickle")}}
m.write_json(out / "set" / "conversations" / "c002" / "manifest.json", manifest)
codes += [step(2, "chat_json"), step(2, "truncate")]
files = {}
for name in m.TRUNCATED_FILES:
    a, b = early / name, full / name
    files[name] = {"early": a.exists(), "full": b.exists(), "equal": a.exists() == b.exists() and (not a.exists() or a.read_bytes() == b.read_bytes())}
kept = m.read_pickle(early / "chat.pickle")
result = {
    "edge": edge, "sizes": sizes, "crossing": c, "codes": codes, "prompted": answered,
    "early_stop": m.read_json(out / "set" / "conversations" / "c001" / "manifest.json")["steps"]["answer@1"]["early_stop"],
    "files": files, "chat_is_prefix": kept == m.read_pickle(full / "chat.pickle")[:len(kept)],
    "chat_json_equal": (early / "chat.json").read_bytes() == (full / "chat.json").read_bytes(),
}
result["check_code"] = m.main(["check-early-stop", "--out", str(out), "--beam-dir", beam_dir, "--conv", "c002"])
print("RESULT " + json.dumps(result), flush=True)
`;

describe('the early stop against BEAM\'s own truncate at b2da22e (local only: needs a BEAM checkout and venv)', () => {
  const beamTest = HAVE_BEAM ? test : test.skip;
  const cases = [
    ['first', 'the turn that passes the limit is the first turn of batch 7', { batch: 7, turn: 1, kept_batches: 6 }],
    ['last', 'it is the last turn of batch 7', { batch: 7, turn: 8, kept_batches: 7, kept_turns_in_last_batch: 7 }],
    ['mid', 'it is the fourth turn of batch 7', { batch: 7, turn: 4, kept_batches: 7, kept_turns_in_last_batch: 3 }],
  ] as const;
  for (const [edge, where, cut] of cases) {
    const title = `BEAM's truncate writes the same four files for the early-stopped chat as for the full chat, and check-early-stop agrees: ${where}`;
    beamTest(HAVE_BEAM ? title : title + NEEDS_BEAM, () => {
      const { result, out, err } = beamCase(edge);
      expect(result.codes).toEqual([0, 0, 0, 0, 0]);
      expect(result.prompted).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(result.early_stop).toMatchObject({ batches_answered: 7, batches_planned: 10, limit: 1_040_000, ...cut });
      if (edge === 'first') expect(result.early_stop.kept_turns_in_last_batch).toBe(result.sizes[5]);
      expect(result.early_stop.beam_printed_tokens).toBeGreaterThan(1_040_000);
      for (const name of ['chat_trunecated.json', 'chat_trunecated.pickle', 'plan_new_trunecated.pickle', 'plan_new_trunecated.txt']) {
        expect(result.files[name]).toEqual({ early: true, full: true, equal: true });
      }
      expect(result.chat_is_prefix).toBe(true);
      expect(result.check_code).toBe(0);
      const check = out.filter(l => l.startsWith('rs1-mint conv=c002 check=') || l.startsWith('rs1-mint conv=c002 file=') || l.startsWith('rs1-mint summary=check-early-stop'));
      expect(check[0]).toBe(`rs1-mint conv=c002 check=early-stop batches=10 stop_after=7 batch=7 turn=${cut.turn} kept_batches=${cut.kept_batches} kept_turns_in_last_batch=${result.early_stop.kept_turns_in_last_batch} beam_printed_tokens=${result.early_stop.beam_printed_tokens} limit=1040000 recorded=match`);
      expect(check.slice(1, 5).every(l => / equal=yes full_sha256=([0-9a-f]{64}) prefix_sha256=\1$/.test(l))).toBe(true);
      expect(check[5]).toBe('rs1-mint summary=check-early-stop conversations=1 files_differ=0');
      expect(out.join('\n') + err).not.toContain(SECRET);
    }, 300_000);
  }

  const title = 'a chat that never passes the limit answers all 10 batches, and chat_json and truncate write what they write today';
  beamTest(HAVE_BEAM ? title : title + NEEDS_BEAM, () => {
    const { result, out, err } = beamCase('none');
    expect(result.codes).toEqual([0, 0, 0, 0, 0]);
    expect(result.prompted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.early_stop).toBeNull();
    for (const name of ['chat_trunecated.json', 'chat_trunecated.pickle', 'plan_new_trunecated.pickle', 'plan_new_trunecated.txt']) {
      expect(result.files[name]).toEqual({ early: false, full: false, equal: true });
    }
    expect(result.chat_json_equal).toBe(true);
    expect(result.check_code).toBe(0);
    expect(out).toContain('rs1-mint conv=c002 check=early-stop batches=10 stop_after=none batch=none turn=none kept_batches=none kept_turns_in_last_batch=none beam_printed_tokens=none limit=1040000 recorded=match');
    expect(out).toContain('rs1-mint summary=check-early-stop conversations=1 files_differ=0');
    expect(out.join('\n') + err).not.toContain(SECRET);
  }, 300_000);
});
