// Step 0: where each harness's native skill listing truncates.
//
// For each harness and catalog size, install the synthetic catalog where the
// harness looks for user skills, point the harness at capture-server.ts,
// run one turn ("Reply with the single word OK"), and parse the skill listing
// out of the request the harness sent. No model is called.
//
// Usage (from the repository root):
//   bun docs/benchmarks/skill-listing-truncation/run.ts \
//     --claude <bin> --codex <bin> --hermes <bin> --openclaw <bin> [--only <harness>] [--sizes 50,300]
// Writes docs/benchmarks/skill-listing-truncation/results/<harness>.json and
// results/listings/<harness>-300.txt. Scratch state lives under /tmp/sl.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { masterCatalog, SIZES, writeCatalog, type SyntheticSkill } from "./catalog.ts";

const HERE = import.meta.dir;
const SCRATCH = "/tmp/sl";
const PROMPT = "Reply with the single word OK";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Entry = { name: string; description: string | null };
type Extracted = { block: string; entries: Entry[]; notices: string[] };
type Cell = { home: string; cwd: string; port: number };
type Harness = {
  id: string;
  label: string;
  version: string;
  fixedCap: number | null;
  bin: string;
  skillsDir: (c: Cell) => string;
  prepare: (c: Cell) => void;
  command: (c: Cell) => { argv: string[]; env: Record<string, string> };
  extract: (requests: any[]) => Extracted;
  budgetProbe?: (c: Cell) => { argv: string[]; read: () => string[] };
};

const textsOf = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textsOf(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => textsOf(x, out));
  return out;
};

const largest = (requests: any[], pathSuffix: string) =>
  requests.filter((r) => r.method === "POST" && r.path.endsWith(pathSuffix) && r.body).sort((a, b) => JSON.stringify(b.body).length - JSON.stringify(a.body).length)[0];

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function findText(body: unknown, marker: string): string {
  const t = textsOf(body).find((s) => s.includes(marker));
  if (!t) throw new Error(`listing marker not found: ${marker}`);
  return t;
}

const BASE_ENV = (c: Cell) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: c.home, LANG: "C.UTF-8", TERM: "dumb" });

const harnesses: Harness[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    version: "2.1.312",
    fixedCap: 1536,
    bin: arg("claude") ?? "claude",
    skillsDir: (c) => join(c.home, ".claude/skills"),
    prepare: () => {},
    command: (c) => ({
      argv: ["-p", PROMPT],
      env: { ...BASE_ENV(c), ANTHROPIC_BASE_URL: `http://127.0.0.1:${c.port}`, ANTHROPIC_API_KEY: "sk-ant-capture-dummy", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
    }),
    budgetProbe: (c) => ({
      argv: ["-p", PROMPT, "--debug"],
      read: () => {
        const dir = join(c.home, ".claude/debug");
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
          .filter((f) => f.endsWith(".txt"))
          .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
          .filter((l) => l.includes("Skill listing over budget") || l.includes("skills via attachment"))
          .map((l) => l.replace(/^\S+ /, "").slice(0, 400));
      },
    }),
    extract: (requests) => {
      const header = "The following skills are available for use with the Skill tool:";
      const req = requests.filter((r) => r.path.endsWith("/messages") && r.body?.tools?.some((t: any) => t.name === "Skill")).at(-1);
      const text = findText(req.body, header);
      const start = text.indexOf(header);
      const lines = text.slice(start + header.length).split("\n");
      const entries: Entry[] = [];
      const kept = [header];
      for (const [i, line] of lines.entries()) {
        if (line === "" && entries.length === 0) {
          kept.push(line);
          continue;
        }
        const m = /^- ([^:\n]+?)(?:: (.*))?$/.exec(line);
        if (!m) {
          if (i > 0) break;
          continue;
        }
        kept.push(line);
        entries.push({ name: m[1], description: m[2] ?? null });
      }
      const notices = textsOf(req.body).filter((s) => /skill/i.test(s) && /(truncat|omitted|not (all|every)|budget)/i.test(s) && s.length < 2000);
      return { block: kept.join("\n"), entries, notices };
    },
  },
  {
    id: "codex",
    label: "Codex",
    version: "0.165.0",
    fixedCap: 1024,
    bin: arg("codex") ?? "codex",
    skillsDir: (c) => join(c.home, ".agents/skills"),
    prepare: (c) => {
      mkdirSync(join(c.home, ".codex"), { recursive: true });
      writeFileSync(join(c.home, ".codex/config.toml"), `openai_base_url = "http://127.0.0.1:${c.port}/v1"\n`);
    },
    command: (c) => ({
      argv: ["exec", "--skip-git-repo-check", PROMPT],
      env: { ...BASE_ENV(c), CODEX_HOME: join(c.home, ".codex"), OPENAI_API_KEY: "sk-capture-dummy", CODEX_API_KEY: "sk-capture-dummy" },
    }),
    extract: (requests) => {
      const req = largest(requests, "/responses");
      const text = findText(req.body, "<skills_instructions>");
      const block = text.slice(text.indexOf("<skills_instructions>"), text.indexOf("</skills_instructions>") + "</skills_instructions>".length);
      const entries: Entry[] = [];
      for (const line of block.split("\n")) {
        const m = /^- ([^:\s]+): (?:(.*) )?\((?:file|executor package|cloud package|custom resource): [^)]*\)$/.exec(line);
        if (m) entries.push({ name: m[1], description: m[2] ?? null });
      }
      return { block, entries, notices: [] };
    },
  },
  {
    id: "hermes",
    label: "Hermes",
    version: "v2026.9.24",
    fixedCap: 60,
    bin: arg("hermes") ?? "hermes",
    skillsDir: (c) => join(c.home, ".hermes/skills/synthetic"),
    prepare: (c) => {
      writeFileSync(
        join(c.home, ".hermes/config.yaml"),
        `model:\n  default: claude-opus-5-5\n  provider: custom\n  base_url: http://127.0.0.1:${c.port}/v1\n  api_key: sk-capture-dummy\n  context_length: 200000\n`,
      );
    },
    command: (c) => ({ argv: ["chat", "-q", PROMPT, "-Q"], env: { ...BASE_ENV(c), HERMES_HOME: join(c.home, ".hermes") } }),
    extract: (requests) => {
      const req = largest(requests, "/chat/completions");
      const text = findText(req.body, "<available_skills>");
      const block = text.slice(text.lastIndexOf("## Skills", text.indexOf("<available_skills>")), text.indexOf("</available_skills>") + "</available_skills>".length);
      const entries: Entry[] = [];
      for (const line of block.split("\n")) {
        const m = /^    - ([^:\n]+?)(?:: (.*))?$/.exec(line);
        if (m) entries.push({ name: m[1], description: m[2] ?? null });
        const names = /^  \S+ \[names only\]: (.*)$/.exec(line);
        if (names) names[1].split(", ").forEach((name) => entries.push({ name, description: null }));
      }
      return { block, entries, notices: [] };
    },
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    version: "2026.10.6",
    fixedCap: null,
    bin: arg("openclaw") ?? "openclaw",
    skillsDir: (c) => join(c.home, ".openclaw/workspace/skills"),
    prepare: (c) => {
      writeFileSync(join(c.home, "openclaw.json"), `{ models: { providers: { anthropic: { baseUrl: "http://127.0.0.1:${c.port}" } } } }\n`);
    },
    command: (c) => ({
      argv: ["agent", "exec", PROMPT, "--config", join(c.home, "openclaw.json"), "--model", "anthropic/claude-opus-5-5", "--cwd", join(c.home, ".openclaw/workspace"), "--json"],
      env: { ...BASE_ENV(c), ANTHROPIC_API_KEY: "sk-ant-capture-dummy" },
    }),
    extract: (requests) => {
      const req = largest(requests, "/messages");
      const text = findText(req.body, "<available_skills>");
      const open = text.indexOf("<available_skills>");
      const close = text.indexOf("</available_skills>") + "</available_skills>".length;
      const lead = text.lastIndexOf("## Skills", open);
      const block = text.slice(lead >= 0 ? lead : open, close);
      const entries: Entry[] = [];
      for (const m of block.matchAll(/<skill>\n\s*<name>(.*?)<\/name>\n(?:\s*<description>([\s\S]*?)<\/description>\n)?/g)) {
        entries.push({ name: unxml(m[1]), description: m[2] === undefined ? null : unxml(m[2]) });
      }
      const notices = block.split("\n").filter((l) => l.includes("Skills truncated") || l.includes("compact format"));
      return { block, entries, notices };
    },
  },
];

// Listings name the harness's own install path for its bundled skills; publish it as a placeholder.
const scrub = (s: string) => s.replace(/\/[^\s<>"']*\/node_modules\//g, "<node_modules>/");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const isSorted = (xs: string[], cmp: (a: string, b: string) => number) => xs.every((x, i) => i === 0 || cmp(xs[i - 1], x) <= 0);
const byteCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function measure(skills: SyntheticSkill[], ex: Extracted, fixedCap: number | null) {
  const original = new Map(skills.map((s) => [s.name, norm(s.description)]));
  const listedSynthetic = ex.entries.filter((e) => original.has(e.name));
  const listedNames = new Set(listedSynthetic.map((e) => e.name));
  const other = ex.entries.filter((e) => !original.has(e.name));
  let full = 0, cut = 0, omitted = 0, altered = 0, cutAtFixedCap = 0;
  const keptChars: number[] = [];
  for (const e of listedSynthetic) {
    const want = original.get(e.name)!;
    if (e.description === null || e.description === "") {
      omitted++;
      keptChars.push(0);
      continue;
    }
    const got = norm(e.description);
    if (got === want) {
      full++;
      keptChars.push(want.length);
      continue;
    }
    const stem = got.replace(/(\.\.\.|…)$/, "").trimEnd();
    if (want.startsWith(stem)) {
      cut++;
      if (fixedCap !== null && want.length > fixedCap) cutAtFixedCap++;
      keptChars.push(stem.length);
    } else {
      altered++;
      keptChars.push(got.length);
    }
  }
  const names = listedSynthetic.map((e) => e.name);
  const described = listedSynthetic.map((e) => e.description !== null && e.description !== "");
  const firstUndescribed = described.indexOf(false);
  const alpha = [...original.keys()].sort(byteCmp);
  const dropped = skills.filter((s) => !listedNames.has(s.name)).map((s) => s.name);
  return {
    catalog: skills.length,
    listed: listedSynthetic.length,
    dropped: dropped.length,
    descriptions: { full, cut, omitted, altered, cut_at_fixed_per_skill_cap: cutAtFixedCap },
    description_chars: {
      original_mean: Math.round(skills.reduce((a, s) => a + norm(s.description).length, 0) / skills.length),
      kept_mean: keptChars.length ? Math.round(keptChars.reduce((a, b) => a + b, 0) / keptChars.length) : 0,
      kept_median: median(keptChars),
      kept_max: keptChars.length ? Math.max(...keptChars) : 0,
    },
    first_listed_without_description: firstUndescribed < 0 ? null : firstUndescribed + 1,
    described_after_first_undescribed: firstUndescribed < 0 ? 0 : described.slice(firstUndescribed).filter(Boolean).length,
    other_listed: other.length,
    other_listed_names: other.map((e) => e.name),
    listing_chars: ex.block.length,
    listing_tokens_approx: Math.ceil(ex.block.length / 4),
    listing_sha256: sha(ex.block),
    order: {
      alphabetical: isSorted(names, byteCmp),
      kept_is_alphabetical_prefix: dropped.length > 0 ? names.every((n, i) => n === alpha[i]) : null,
      kept_is_install_order_prefix: dropped.length > 0 ? skills.slice(0, names.length).every((s) => listedNames.has(s.name)) : null,
    },
    notices: ex.notices.map(scrub),
    first_entries: ex.entries.slice(0, 2),
    last_entries: ex.entries.slice(-2),
  };
}

async function runCell(h: Harness, skills: SyntheticSkill[], port: number, probe = false) {
  const home = join(SCRATCH, h.id.slice(0, 2), "alice");
  rmSync(join(SCRATCH, h.id.slice(0, 2)), { recursive: true, force: true });
  const cell: Cell = { home, cwd: join(home, "project"), port };
  mkdirSync(cell.cwd, { recursive: true });
  mkdirSync(h.skillsDir(cell), { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeCatalog(skills, h.skillsDir(cell));
  h.prepare(cell);
  const capture = join(SCRATCH, `${h.id}-${skills.length}.jsonl`);
  rmSync(capture, { force: true });
  const server = Bun.spawn(["bun", join(HERE, "capture-server.ts"), String(port), capture], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(500);
  const { argv: baseArgv, env } = h.command(cell);
  const argv = probe && h.budgetProbe ? h.budgetProbe(cell).argv : baseArgv;
  const proc = Bun.spawn([h.bin, ...argv], { cwd: h.id === "openclaw" ? join(home, ".openclaw/workspace") : cell.cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), 300_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  clearTimeout(timer);
  server.kill();
  await server.exited;
  const probeLines = probe && h.budgetProbe ? h.budgetProbe(cell).read() : [];
  const requests = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ex = h.extract(requests);
  const harnessNotices = (stdout + "\n" + stderr).split("\n").filter((l) => /skill/i.test(l) && /(budget|truncat|not included|omitted)/i.test(l)).map((l) => l.trim().slice(0, 400));
  const model = requests.map((r) => r.body?.model).find((m) => typeof m === "string" && m !== "") ?? null;
  return { exit, model, probeLines, ex: { ...ex, notices: [...new Set([...ex.notices, ...harnessNotices])] } };
}

const only = arg("only");
const sizes = (arg("sizes") ?? SIZES.join(",")).split(",").map(Number);
const master = masterCatalog();
mkdirSync(join(HERE, "results/listings"), { recursive: true });

for (const [i, h] of harnesses.entries()) {
  if (only && h.id !== only) continue;
  const cells = [];
  for (const n of sizes) {
    const skills = master.slice(0, n);
    const a = await runCell(h, skills, 18800 + i);
    const b = await runCell(h, skills, 18800 + i);
    const m = measure(skills, a.ex, h.fixedCap);
    const probe = h.budgetProbe ? (await runCell(h, skills, 18800 + i, true)).probeLines : undefined;
    cells.push({ size: n, exit: a.exit, model: a.model, deterministic: sha(a.ex.block) === sha(b.ex.block), ...m, ...(probe ? { debug_log: probe } : {}) });
    if (n === 300) writeFileSync(join(HERE, `results/listings/${h.id}-300.txt`), scrub(a.ex.block) + "\n");
    console.log(`${h.id} n=${n} exit=${a.exit} listed=${m.listed} dropped=${m.dropped} full=${m.descriptions.full} cut=${m.descriptions.cut} omitted=${m.descriptions.omitted} altered=${m.descriptions.altered} kept_mean=${m.description_chars.kept_mean} chars=${m.listing_chars} other=${m.other_listed} det=${sha(a.ex.block) === sha(b.ex.block)}`);
  }
  const out = join(HERE, `results/${h.id}.json`);
  const previous = existsSync(out) && only && arg("sizes") ? JSON.parse(readFileSync(out, "utf8")).cells.filter((c: any) => !sizes.includes(c.size)) : [];
  writeFileSync(
    out,
    JSON.stringify({ harness: h.label, version: h.version, fixed_per_skill_description_cap: h.fixedCap, prompt: PROMPT, cells: [...previous, ...cells].sort((x, y) => x.size - y.size) }, null, 2) + "\n",
  );
}
