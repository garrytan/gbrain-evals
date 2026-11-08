// Description lengths of real, permissively licensed public skills. Records
// each source's repository, commit and licence, and each skill's normalized
// description length in characters. Only names and lengths are stored.
//
// Usage: bun lengths.ts --gbrain <checkout> --gstack <checkout> --anthropic <checkout> > description-lengths.json

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

export function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  return (Bun.YAML.parse(m[1]) as Record<string, unknown>) ?? {};
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

function commit(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function skillsIn(dirs: string[]): Array<{ skill: string; chars: number; file: string }> {
  const out: Array<{ skill: string; chars: number; file: string }> = [];
  for (const file of dirs) {
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, "utf8"));
    const description = typeof fm.description === "string" ? normalize(fm.description) : "";
    if (!description) continue;
    out.push({ skill: String(fm.name ?? file.split("/").at(-2)), chars: [...description].length, file });
  }
  return out.sort((a, b) => a.skill.localeCompare(b.skill));
}

const subdirs = (root: string) => readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

const gbrain = arg("gbrain");
const gstack = arg("gstack");
const anthropic = arg("anthropic");

const anthropicFiles = subdirs(join(anthropic, "skills")).map((d) => join(anthropic, "skills", d, "SKILL.md"));
const apache = (file: string) => {
  const lic = join(file, "..", "LICENSE.txt");
  return existsSync(lic) && readFileSync(lic, "utf8").includes("Apache License");
};

const sources = [
  {
    name: "gbrain bundled skills",
    repo: "github.com/garrytan/gbrain",
    commit: commit(gbrain),
    licence: "MIT (repository LICENSE)",
    glob: "skills/*/SKILL.md",
    skills: skillsIn(subdirs(join(gbrain, "skills")).map((d) => join(gbrain, "skills", d, "SKILL.md"))),
  },
  {
    name: "gstack skills",
    repo: "github.com/garrytan/gstack",
    commit: commit(gstack),
    licence: "MIT (repository LICENSE)",
    glob: "SKILL.md, */SKILL.md",
    skills: skillsIn([join(gstack, "SKILL.md"), ...subdirs(gstack).map((d) => join(gstack, d, "SKILL.md"))]),
  },
  {
    name: "anthropics/skills",
    repo: "github.com/anthropics/skills",
    commit: commit(anthropic),
    licence: "Apache-2.0 (per-skill LICENSE.txt); skills without a licence file are excluded",
    glob: "skills/*/SKILL.md with an Apache-2.0 LICENSE.txt",
    skills: skillsIn(anthropicFiles.filter(apache)),
    excluded: anthropicFiles.filter((f) => existsSync(f) && !apache(f)).map((f) => f.split("/").at(-2)),
  },
];

console.log(
  JSON.stringify(
    {
      schema_version: 1,
      measure: "characters (code points) of the frontmatter description after collapsing whitespace",
      sources: sources.map(({ skills, ...rest }) => ({ ...rest, count: skills.length, skills: skills.map(({ skill, chars }) => ({ skill, chars })) })),
    },
    null,
    2,
  ),
);
