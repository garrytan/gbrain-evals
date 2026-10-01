/**
 * N13 scout gold from the TypeScript compiler (independent of gbrain).
 *
 * Built once from the vendored pathe snapshot with the pinned `typescript`
 * devDependency and committed as eval/data/n13-code-scout/ts-gold.json. The
 * runner reads the committed file and checks its hash; a test rebuilds it and
 * requires byte-identical output, so CI never trusts a hand edit.
 *
 * What it records, per top-level function in the corpus (function
 * declarations and `const name = function / arrow` statements):
 *   - the declaration's file and line span;
 *   - every reference the language service finds (findReferences), as file
 *     and line, definition excluded;
 *   - every call site whose callee the type checker resolves to that
 *     declaration (aliases followed through imports), with the enclosing
 *     top-level caller, and whether caller and callee share a file.
 *
 * This is narrow sanity gold for a readiness scout, not SCIP-grade call and
 * flow gold: it covers one small repository, top-level functions only, and
 * static calls the checker can resolve. Broad quality claims wait for
 * independent call and flow gold (plan amendment 9).
 *
 * Usage: bun eval/generators/n13-ts-gold.ts [--write]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { N13_CORPUS_DIR, verifyVendoredCorpus } from './n13-code-scout-vendor.ts';

export const N13_GOLD_VERSION = 'n13-ts-gold/1';
export const N13_GOLD_PATH = join(N13_CORPUS_DIR, 'ts-gold.json');

export interface GoldFunction {
  name: string;
  file: string;
  start_line: number;
  end_line: number;
  exported: boolean;
  references: Array<{ file: string; line: number }>;
}

export interface GoldCall { caller: string; caller_file: string; callee: string; callee_file: string; line: number; same_file: boolean }

export interface N13Gold {
  generator_version: string;
  typescript_version: string;
  corpus_commit: string;
  functions: GoldFunction[];
  calls: GoldCall[];
}

export function buildTsGold(): N13Gold {
  const { manifest, problems, files } = verifyVendoredCorpus();
  if (problems.length) throw new Error(`vendored corpus hash check failed:\n  ${problems.join('\n  ')}`);
  const sources = new Map(files.map(f => [f.path, f.content]));
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noLib: true, allowJs: false, types: [] };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...sources.keys()],
    getScriptVersion: () => '1',
    getScriptSnapshot: name => (sources.has(name) ? ts.ScriptSnapshot.fromString(sources.get(name)!) : undefined),
    getCurrentDirectory: () => '',
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => 'lib.d.ts',
    fileExists: name => sources.has(name),
    readFile: name => sources.get(name),
    resolveModuleNames: (names, containing) => names.map(n => {
      const base = containing.split('/').slice(0, -1).join('/');
      const candidate = `${base}/${n.replace(/^\.\//, '')}`.replace(/\/\.\//g, '/');
      const hit = [`${candidate}.ts`, `${candidate}/index.ts`].find(c => sources.has(c));
      return hit ? { resolvedFileName: hit, extension: ts.Extension.Ts } : undefined;
    }),
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = ls.getProgram()!;
  const checker = program.getTypeChecker();
  const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const functions: GoldFunction[] = [];
  const declToName = new Map<ts.Node, { name: string; file: string }>();
  for (const file of [...sources.keys()].sort()) {
    const sf = program.getSourceFile(file)!;
    for (const st of sf.statements) {
      const exported = !!ts.getModifiers(st as ts.HasModifiers)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      const add = (nameNode: ts.Identifier, decl: ts.Node) => {
        const refs = (ls.findReferences(file, nameNode.getStart(sf)) ?? []).flatMap(r => r.references)
          .filter(r => !r.isDefinition)
          .map(r => ({ file: r.fileName, line: lineOf(program.getSourceFile(r.fileName)!, r.textSpan.start) }));
        const uniq = [...new Map(refs.map(r => [`${r.file}:${r.line}`, r])).values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
        functions.push({ name: nameNode.text, file, start_line: lineOf(sf, st.getStart(sf)), end_line: lineOf(sf, st.getEnd()), exported, references: uniq });
        declToName.set(decl, { name: nameNode.text, file });
      };
      if (ts.isFunctionDeclaration(st) && st.name) add(st.name, st);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && (ts.isFunctionExpression(d.initializer) || ts.isArrowFunction(d.initializer))) add(d.name, d);
        }
      }
    }
  }

  const calls: GoldCall[] = [];
  const topLevelOwner = (node: ts.Node): { name: string; file: string } | undefined => {
    let cur: ts.Node | undefined = node;
    while (cur) {
      const hit = declToName.get(cur);
      if (hit) return hit;
      cur = cur.parent;
    }
    return undefined;
  };
  for (const file of [...sources.keys()].sort()) {
    const sf = program.getSourceFile(file)!;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const target = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
        let sym = checker.getSymbolAtLocation(target);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
        const callee = decl ? declToName.get(decl) : undefined;
        const caller = topLevelOwner(n);
        if (callee && caller) calls.push({ caller: caller.name, caller_file: caller.file, callee: callee.name, callee_file: callee.file, line: lineOf(sf, n.getStart(sf)), same_file: caller.file === callee.file });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { generator_version: N13_GOLD_VERSION, typescript_version: ts.version, corpus_commit: manifest.commit, functions, calls };
}

export const goldJson = (g: N13Gold) => JSON.stringify(g, null, 2) + '\n';
export const goldSha256 = (text: string) => createHash('sha256').update(text).digest('hex');

if (import.meta.main) {
  const g = buildTsGold();
  const text = goldJson(g);
  if (process.argv.includes('--write')) writeFileSync(N13_GOLD_PATH, text);
  console.log(`${N13_GOLD_VERSION} typescript ${g.typescript_version}: ${g.functions.length} functions, ${g.calls.length} resolved calls (${g.calls.filter(c => !c.same_file).length} cross-file); sha256 ${goldSha256(text)}${process.argv.includes('--write') ? ` -> ${N13_GOLD_PATH}` : ''}`);
}
