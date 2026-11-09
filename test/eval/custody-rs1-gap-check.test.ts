/**
 * RS1 custody scripts (GST-1154, #359): rs1_mint.py's gap checks on the question and answer steps, the two that call BEAM
 * through loops that swallow a model error. Keyless: BEAM's answer_generation is a stub with its control flow, the Google
 * client is a fake behind the real RecordingModel, and nothing reaches a provider. Every message holds a marker word, so
 * any text that reaches stdout or stderr shows.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
const RS1 = join(REPO, 'eval/custody/rs1');
const SECRET = 'sealedtext';
const seedLine = (name: string) => ['rs1', 'seed', 'v1'].join('-') + ':' + createHash('sha256').update(name).digest('hex');

const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Runs one harness scenario in a fresh directory: its RESULT line, and every other line it printed. */
function scenario(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rs1-gaps-'));
  roots.push(dir);
  writeFileSync(join(dir, 'k.rs1-seed'), seedLine(`gap test ${name}`) + '\n', { mode: 0o600 });
  const r = run('python3', ['-c', HARNESS, RS1, name, dir, join(dir, 'k.rs1-seed')]);
  const lines = r.out.split('\n').filter(Boolean);
  const result = lines.find(l => l.startsWith('RESULT '));
  if (!result) throw new Error(`scenario ${name} printed no RESULT (exit ${r.code})`);
  return { result: JSON.parse(result.slice(7)), out: lines.filter(l => !l.startsWith('RESULT ')), err: r.err };
}

const HARNESS = String.raw`import json, os, pickle, sys, types
from pathlib import Path

rs1_dir, scenario, root, seed_file = sys.argv[1:5]
sys.path.insert(0, rs1_dir)
import rs1_mint as m

SECRET = "sealedtext"
B, Q, FOLLOW = 3, 8, 4


def plan_text(b):
    bullets = ["Time Anchor: March %d, 2024" % b] + ["Point %d: %s point %d-%d" % (k, SECRET, b, k) for k in range(2, 28)]
    bullets += ["Information Update: %s update %d" % (SECRET, b), "User Instruction: %s reply in lists %d" % (SECRET, b),
                "Logical Contradiction: %s contradiction %d" % (SECRET, b)]
    return "BATCH %d PLAN\n" % b + "\n".join("\u2022 **%s:**%s" % tuple(x.split(":", 1)) for x in bullets)


def beam_question_lines(b, normal=90, special=2):
    lines = ["%s question %d-%d ->-> %d,%d" % (SECRET, b, i, b, 1 + i // 3) for i in range(normal)]
    tail = ["%s update line %d ->-> %d,28" % (SECRET, b, b), "%s contradiction line %d ->-> %d,30" % (SECRET, b, b)][:special]
    return lines + tail[:1] + ["%s reply in lists %d ->-> %d,29" % (SECRET, b, b)] + tail[1:]


def conversation(out, cid, mode="real"):
    conv = out / "set" / "conversations" / cid
    beam_chat = conv / "beam" / "1"
    beam_chat.mkdir(parents=True, exist_ok=True)
    topic = {"id": 1, "category": "Travel", "title": SECRET + " title", "theme": SECRET + " theme", "subtopics": ["a", "b", "c"]}
    m.write_json(conv / "topic.json", topic)
    m.write_json(beam_chat / "topic.json", topic)
    m.write_pickle(beam_chat / "plan_new.pickle", [plan_text(b) for b in range(1, 11)])
    m.write_json(conv / "manifest.json", {"schema": "rs1-mint-manifest/v1", "conversation": cid, "index": int(cid[1:]),
                                          "mode": mode, "beam_commit": m.BEAM_COMMIT,
                                          "steps": {"topic_check@1": {"status": "done", "verdict": "accepted", "outputs": {}}}})
    return conv, beam_chat


def answer_questions():
    return [{"time_anchor": "March-%d" % b, "messages": [["%s question %d-%d%s" % (SECRET, b, i, " follow" if i == FOLLOW else "")
                                                          for i in range(Q)]]} for b in range(1, B + 1)]


class ApiError(Exception):
    def __init__(self, code):
        super().__init__("provider detail")
        self.code = code


class Inner:
    """The Google client behind RecordingModel: a fault is an HTTP status it raises after its own resend, or an empty reply."""

    def __init__(self, faults):
        self.faults, self.prompts = faults, []

    def invoke(self, value, **kwargs):
        self.prompts.append(value)
        fault = next((f for marker, f in self.faults.items() if marker in value), None)
        if fault == "empty":
            return types.SimpleNamespace(content=" ", usage_metadata={})
        if fault is not None:
            try:
                raise ApiError(fault)
            except ApiError as error:
                raise RuntimeError("client wrapper") from error
        return types.SimpleNamespace(content=SECRET + " reply to " + value, usage_metadata={"input_tokens": 3, "output_tokens": 2})


def answer_generation(input_address, output_address, plans_address, topic, theme, llm):
    """BEAM's answer_generation (src/beam/main.py:1775-2093) cut down to its control flow: it resumes after the batches
    in chat.pickle, numbers messages from 0, swallows any Exception per question, and keeps a batch only if it holds at
    least 2 * questions - 10 messages."""
    with open(input_address, "rb") as f:
        batches = pickle.load(f)
    all_messages = []
    if os.path.isfile(output_address):
        with open(output_address, "rb") as f:
            all_messages = pickle.load(f)
    n = 0
    for batch_index, batch in enumerate(batches[len(all_messages):], start=len(all_messages)):
        history, messages = [], batch["messages"][0]
        for question in messages:
            try:
                reply = llm.invoke(question).content
                history += [{"role": "user", "id": n, "question_type": "main_question", "content": question},
                            {"role": "assistant", "id": n + 1, "content": reply}]
                n += 2
                if question.endswith(" follow"):
                    user = llm.invoke("follow-up to " + question).content
                    history.append({"role": "user", "id": n, "question_type": "followup_question", "content": user})
                    n += 1
                    reply = llm.invoke("answer to " + user).content
                    history.append({"role": "assistant", "id": n, "content": reply})
                    n += 1
            except Exception:
                continue
        if history and len(history) >= len(messages) * 2 - 10:
            all_messages.append(history)
            with open(output_address, "wb") as f:
                pickle.dump(all_messages, f)
        else:
            break
    with open(output_address, "wb") as f:
        pickle.dump(all_messages, f)


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


def step(out, name, inner=None, question_batches=None):
    def run_question_generation(chats_directory, chat_size, index):
        m.write_pickle(Path(chats_directory) / "1" / "user_messages.pickle", question_batches)

    # BEAM's chat_json and truncate code for the answer step's early-stop check: a chat this short never passes the limit.
    m.load_beam = lambda beam_dir, slot: types.SimpleNamespace(
        main=types.SimpleNamespace(answer_generation=answer_generation),
        run_pipeline=types.SimpleNamespace(run_question_generation=run_question_generation),
        utils=types.SimpleNamespace(convert_chats_pickle_to_json=lambda src, dst: m.write_json(dst, []),
                                    add_ids_to_chats=lambda src, dst: m.write_json(dst, [])),
        adjust=types.SimpleNamespace(count_chats_tokens=lambda chat_directory, model_name, token_limit: None))
    m.gemini_model = lambda temperature, usage: m.RecordingModel(inner, "gemini:test", usage)
    return m.main(["step", "--out", str(out), "--conv-index", "1", "--step", name, "--seed-file", seed_file,
                   "--mode", "real", "--beam-dir", str(out)] + window_args(out))


def batches_prompted(inner):
    return sorted({int(p.split("question ")[1].split("-")[0]) for p in inner.prompts})


def report(**fields):
    print("RESULT " + json.dumps(fields), flush=True)


out = Path(root) / "rs1-custody-gaps"
if scenario.startswith("answer-"):
    conv, beam_chat = conversation(out, "c001")
    m.write_pickle(beam_chat / "user_messages.pickle", answer_questions())
    faults = {
        "answer-clean": {},
        "answer-drop": {"question 2-3": 503},
        "answer-empty": {"question 2-5": "empty"},
        "answer-unanswered": {"answer to " + SECRET + " reply to follow-up to " + SECRET + " question 1-4": 429},
        "answer-followup": {"follow-up to " + SECRET + " question 1-4": 429},
        "answer-missing": {"question 3-%d" % i: 502 for i in range(6)},
    }[scenario]
    inner = Inner(faults)
    code = step(out, "answer", inner)
    chat = m.read_pickle(beam_chat / "chat.pickle")
    fields = {"code": code, "batches": len(chat), "prompted": batches_prompted(inner),
              "done": m.read_json(conv / "manifest.json")["steps"].get("answer@1", {}).get("status"),
              "partial_left": (beam_chat / "answer-input.pickle").exists()}
    if scenario == "answer-drop":
        kept = pickle.dumps(chat)
        inner = Inner({})
        fields["resume"] = {"code": step(out, "answer", inner), "prompted": batches_prompted(inner)}
        chat = m.read_pickle(beam_chat / "chat.pickle")
        entry = m.read_json(conv / "manifest.json")["steps"]["answer@1"]
        fields["resume"].update({
            "batches": len(chat), "done": entry["status"], "kept_batch_1": pickle.dumps(chat[:1]) == kept,
            "recorded": entry["outputs"] == {"beam/1/chat.pickle": m.sha256_file(beam_chat / "chat.pickle")},
            "ids_in_order": [x["id"] for b in chat for x in b] == list(range(sum(map(len, chat)))),
            "gaps": m.answer_gaps(answer_questions(), chat)["gap_batches"]})
    report(**fields)
elif scenario.startswith("question-"):
    conv, beam_chat = conversation(out, "c001")
    batches = [beam_question_lines(b) for b in range(1, 11)]
    if scenario == "question-natural":
        batches[2] = beam_question_lines(3, normal=84)
    if scenario == "question-subbatch":
        batches[3] = beam_question_lines(4, normal=81)
    if scenario == "question-special":
        batches[6] = beam_question_lines(7, special=0)
    code = step(out, "question", question_batches=[{"time_anchor": "x", "messages": [lines]} for lines in batches])
    report(code=code, done=m.read_json(conv / "manifest.json")["steps"].get("question@1", {}).get("status"))
elif scenario == "check-setup":
    for cid, damaged in (("c001", True), ("c002", False)):
        conv, beam_chat = conversation(out, cid)
        questions = [{"time_anchor": "x", "messages": [beam_question_lines(b)]} for b in range(1, 11)]
        m.write_pickle(beam_chat / "user_messages.pickle", questions)
        chat = [[x for i, q in enumerate(batch["messages"][0]) if not (damaged and b == 2 and i == 7)
                 for x in ({"role": "user", "question_type": "main_question", "content": q}, {"role": "assistant", "content": SECRET + " reply"})]
                for b, batch in enumerate(questions, 1)]
        m.write_pickle(beam_chat / "chat.pickle", chat)
        manifest = m.read_json(conv / "manifest.json")
        for name, rel in (("question", "user_messages.pickle"), ("answer", "chat.pickle")):
            manifest["steps"][name + "@1"] = {"status": "done", "outputs": {"beam/1/" + rel: m.sha256_file(beam_chat / rel)}}
        m.write_json(conv / "manifest.json", manifest)
    conversation(out, "c003", mode="fake")
    report(out=str(out))
`;

describe('rs1_mint.py answer-step gap check', () => {
  test('a clean run passes: every batch is answered and chat.pickle is recorded as done', () => {
    const s = scenario('answer-clean');
    expect(s.err).toBe('');
    expect(s.result).toEqual({ code: 0, batches: 3, prompted: [1, 2, 3], done: 'done', partial_left: false });
  });

  test('a swallowed 503 drops a question: the step fails with counts only, cuts chat.pickle back, and a rerun regenerates that batch alone', () => {
    const s = scenario('answer-drop');
    expect(s.err).toBe('rs1-mint refused: answer batch 2 of 3 lost output to a swallowed error: batches=2/2 intact_batches=1 '
      + 'gap_batches=2 missing=0 dropped=1 unmatched=0 unanswered=0 empty=0 model_errors=1; chat.pickle is cut back to 1 intact batches\n');
    expect(s.result).toEqual({
      code: 1, batches: 1, prompted: [1, 2], done: null, partial_left: false,
      resume: { code: 0, prompted: [2, 3], batches: 3, done: 'done', kept_batch_1: true, recorded: true, ids_in_order: true, gaps: [] },
    });
    expect(s.out.every(l => l.startsWith('rs1-mint conv=c001 step=answer status='))).toBe(true);
    expect(s.out.join('\n') + s.err).not.toContain(SECRET);
  });

  test('an empty reply, a follow-up left with no reply and a batch BEAM dropped each fail the step', () => {
    const cases = { 'answer-empty': [2, 1, 'empty=1'], 'answer-unanswered': [1, 0, 'unanswered=1'], 'answer-missing': [3, 2, 'missing=1'] } as const;
    for (const [name, [batch, kept, count]] of Object.entries(cases)) {
      const s = scenario(name);
      expect(s.result).toMatchObject({ code: 1, batches: kept, done: null, partial_left: false });
      expect(s.err).toContain(`answer batch ${batch} of 3 lost output to a swallowed error`);
      expect(s.err).toContain(count);
      expect(s.err).toContain(`cut back to ${kept} intact batches`);
      expect(s.out.join('\n') + s.err).not.toContain(SECRET);
    }
  });

  test('a swallowed error that leaves no gap in the output, here a follow-up whose user turn failed, still fails the batch', () => {
    const s = scenario('answer-followup');
    expect(s.result).toEqual({ code: 1, batches: 0, prompted: [1], done: null, partial_left: false });
    expect(s.err).toBe('rs1-mint refused: answer batch 1 of 3 lost output to a swallowed error: batches=1/1 intact_batches=1 '
      + 'gap_batches=none missing=0 dropped=0 unmatched=0 unanswered=0 empty=0 model_errors=1; chat.pickle is cut back to 0 intact batches\n');
    expect(s.out.join('\n') + s.err).not.toContain(SECRET);
  });
});

describe('rs1_mint.py question-step gap check', () => {
  test('a full or naturally deduplicated output passes; a lost sub-batch or special sub-batch fails with counts only', () => {
    expect(scenario('question-clean').result).toEqual({ code: 0, done: 'done' });
    expect(scenario('question-natural').result).toEqual({ code: 0, done: 'done' });
    const sub = scenario('question-subbatch');
    expect(sub.result).toEqual({ code: 1, done: null });
    expect(sub.err).toBe('rs1-mint refused: the question step lost output to a swallowed error: batches=10/10 gap_batches=4 '
      + 'short=1 special_missing=0 min_messages=84 floor=85\n');
    const special = scenario('question-special');
    expect(special.result).toEqual({ code: 1, done: null });
    expect(special.err).toContain('gap_batches=7 short=0 special_missing=1');
    expect(sub.out.join('\n') + sub.err + special.out.join('\n') + special.err).not.toContain(SECRET);
  });
});

describe('rs1_mint.py check-gaps', () => {
  test('prints counts, batch numbers and hashes only, and exits 1 when a finished step has gaps', () => {
    const { out } = scenario('check-setup').result as { out: string };
    const r = run('python3', [join(RS1, 'rs1_mint.py'), 'check-gaps', '--out', out]);
    expect(r.err).toBe('');
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(SECRET);
    const lines = r.out.trim().split('\n');
    expect(lines.every(l => /^rs1-mint( [a-z0-9_]+=[0-9a-z,/-]+)+$/.test(l))).toBe(true);
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/^rs1-mint conv=c001 step=answer gaps=1 batches=10\/10 intact_batches=1 gap_batches=2 missing=0 dropped=1 unmatched=0 unanswered=0 empty=0 early_stop=none sha256=[0-9a-f]{64} recorded=match$/);
    expect(lines.filter(l => l.includes(' gaps=0 '))).toHaveLength(3);
    expect(lines[4]).toBe('rs1-mint summary=check-gaps conversations=3 steps_checked=4 steps_with_gaps=1 fake_skipped=1');
  });
});
