/**
 * RS1 custody scripts (GST-1154, GBEV-36): the answer step stops generating batches once the chat has passed BEAM's
 * truncation limit. Keyless: BEAM's answer, chat_json and truncate code are stubs with BEAM's control flow and file
 * shapes (every turn counts a fixed number of tokens), nothing reaches a provider, and every message holds a marker
 * word, so any text that reaches stdout or stderr shows.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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


def step(name):
    seen["prompted"].clear()
    code = m.main(["step", "--out", str(out), "--conv-index", "1", "--step", name, "--seed-file", seed_file, "--mode", "real",
                   "--beam-dir", str(out)])
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
print("RESULT " + json.dumps({"out": str(out), "first": first, "rerun": rerun, "crashed": crashed, "truncate": truncate}), flush=True)
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
