// Skill-load and mutation detection over a trial's tool calls (Claude Code and Codex).
// A skill counts as loaded when the agent read its body:
//   spring  "<gbrain> bundled-skill <name>" in a shell (without --asset)
//   native  the Claude Code Skill tool, Codex's skills tool, or a read of <name>/SKILL.md
//   any     a plain MCP get_skill {name} that returned without an error
export type Load = { skill: string; via: string; index: number };

const SHELL_TOOLS = new Set(['Bash', 'shell']);
const commandOf = (c: any) => String(c.input?.command ?? '');
const READERS = /\b(cat|sed|head|tail|less|more|nl|awk|bat|python3?|node|bun|grep|rg)\b/;

export function detectSkillLoads(calls: any[]): Load[] {
  const loads: Load[] = [];
  calls.forEach((c, index) => {
    if (c.error) return;
    const inp = c.input ?? {};
    if (c.tool === 'gbrain:get_skill' && typeof inp.name === 'string') loads.push({ skill: inp.name, via: 'mcp-get_skill', index });
    if (c.tool === 'Skill') { const n = String(inp.skill ?? inp.command ?? inp.name ?? '').replace(/^.*:/, '').trim(); if (n) loads.push({ skill: n, via: 'skill-tool', index }); }
    if (c.tool === 'Read' && typeof inp.file_path === 'string') { const m = /([a-z0-9-]+)\/SKILL\.md$/.exec(inp.file_path); if (m) loads.push({ skill: m[1]!, via: 'read', index }); }
    if (c.tool.startsWith('codex-item:') || c.tool.startsWith('skills:')) {
      const s = JSON.stringify(inp);
      for (const m of s.matchAll(/([a-z0-9-]+)\/SKILL\.md/g)) loads.push({ skill: m[1]!, via: 'codex-skill', index });
    }
    if (SHELL_TOOLS.has(c.tool)) {
      const cmd = commandOf(c);
      for (const seg of cmd.split(/&&|\|\||;|\n/)) {
        const m = /\bbundled-skill\s+([a-z0-9][a-z0-9-]*)\b/.exec(seg);
        if (m && !/--asset\b/.test(seg)) loads.push({ skill: m[1]!, via: 'cli-bundled-skill', index });
        if (READERS.test(seg)) for (const r of seg.matchAll(/([a-z0-9-]+)\/SKILL\.md\b/g)) loads.push({ skill: r[1]!, via: 'shell-read', index });
      }
    }
  });
  return loads;
}

const SHELL_MUTATION = /(^|[\s;&|(])(rm|rmdir|mv|unlink|truncate|tee|touch|mkdir|cp)\s|\bsed\s+-i|\bperl\s+-[a-z]*i|(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null|&)[^\s&|;]+|bin\/cal\s+create|\b(gbrain|cli\.ts)\s+(put|capture|delete|remember|forget|link|unlink|tag|untag|sync|import|timeline-add|restore|pages\s+purge)\b|\bgit\s+(commit|rm|add|push|mv|checkout\s+--)\b|\bpython3?\s+-c\b.*\b(write|unlink|remove|rmtree)\b/;

export function isMutation(c: any, writeTools: Set<string>): boolean {
  if (c.tool.startsWith('gbrain:')) return writeTools.has(c.tool.slice(7));
  if (c.tool === 'Write' || c.tool === 'Edit' || c.tool === 'MultiEdit' || c.tool === 'NotebookEdit' || c.tool === 'file_change') return true;
  if (SHELL_TOOLS.has(c.tool)) return SHELL_MUTATION.test(commandOf(c));
  return false;
}
