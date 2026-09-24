import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

export interface ResolvedRegressionProduct {
  declared_pin: string;
  package_version: string;
  package_path: string;
  product_sha: string | null;
  product_tree: string | null;
  package_sha256: string;
  dirty: boolean | null;
  bindings: Record<'package' | 'deep_import' | 'GBRAIN_SRC' | 'GBRAIN_REPO', { path: string; sha: string | null; tree: string | null; package_sha256: string }>;
}

function git(path: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function regressionPackageHash(root: string): string {
  const hash = createHash('sha256');
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative)).sort()) {
      if (['.git', 'node_modules'].includes(entry) && relative === '') continue;
      const name = join(relative, entry);
      const path = join(root, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`unverifiable package symlink: ${name}`);
      if (stat.isDirectory()) walk(name);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
        hash.update(bytes);
      }
    }
  };
  walk('');
  return hash.digest('hex');
}

export function resolveRegressionProduct(options: {
  evalRoot?: string;
  expectedProductSha?: string;
  expectedProductTree?: string;
  expectedPackageSha256?: string;
  requireClean?: boolean;
  env?: Record<string, string | undefined>;
  importerPath?: string;
} = {}): ResolvedRegressionProduct {
  const evalRoot = resolve(options.evalRoot ?? process.cwd());
  const declared = JSON.parse(readFileSync(join(evalRoot, 'package.json'), 'utf8'));
  const resolvePackage = (from: string): string => {
    for (let directory = dirname(from); ; directory = dirname(directory)) {
      const installed = join(directory, 'node_modules/gbrain');
      if (existsSync(installed)) return realpathSync(installed);
      if (dirname(directory) === directory) break;
    }
    const require = createRequire(from);
    let installed: string;
    try { installed = dirname(require.resolve('gbrain/package.json')); }
    catch {
      installed = dirname(require.resolve('gbrain'));
      while (!existsSync(join(installed, 'package.json')) && dirname(installed) !== installed) installed = dirname(installed);
    }
    return realpathSync(installed);
  };
  const importers = [join(evalRoot, 'package.json'), join(evalRoot, 'eval/runner/__identity__.ts'), join(evalRoot, 'eval/runner/adapters/__identity__.ts'), join(evalRoot, 'eval/precisionmembench/__identity__.ts'), ...(options.importerPath ? [resolve(options.importerPath)] : [])];
  const packagePath = resolvePackage(importers[1]);
  if (importers.some(from => resolvePackage(from) !== packagePath)) throw new Error('package import resolution differs between root, runner, adapter or PrecisionMemBench scopes');
  for (const from of importers) {
    const require = createRequire(from);
    const pkg = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
    for (const specifier of ['gbrain/search/hybrid', 'gbrain/operations', 'gbrain/pglite-engine']) {
      if (!pkg.exports?.[`./${specifier.slice('gbrain/'.length)}`]) continue;
      const deep = realpathSync(require.resolve(specifier));
      if (!deep.startsWith(packagePath + '/')) throw new Error('deep import resolves outside the verified package');
    }
  }
  const pkg = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
  if (pkg.name !== 'gbrain' || typeof pkg.version !== 'string' || typeof declared.dependencies?.gbrain !== 'string') {
    throw new Error('gbrain package name, version or declared pin missing');
  }
  const exactGitRoot = git(packagePath, ['rev-parse', '--show-toplevel']);
  const inProductRepo = exactGitRoot !== null && realpathSync(exactGitRoot) === packagePath;
  const sha = inProductRepo ? git(packagePath, ['rev-parse', 'HEAD']) : null;
  const tree = inProductRepo ? git(packagePath, ['rev-parse', 'HEAD^{tree}']) : null;
  const status = inProductRepo ? git(packagePath, ['status', '--porcelain', '--untracked-files=all']) : null;
  const dirty = status === null ? null : status !== '';
  const digest = regressionPackageHash(packagePath);
  if (options.expectedProductSha && sha !== options.expectedProductSha && !options.expectedPackageSha256) {
    throw new Error('loaded gbrain commit does not match expected product SHA');
  }
  if (sha && options.expectedProductSha && sha !== options.expectedProductSha) throw new Error('loaded gbrain commit mismatch');
  if (options.expectedProductTree && tree !== options.expectedProductTree && (tree !== null || !options.expectedPackageSha256)) throw new Error('loaded gbrain tree mismatch');
  if (options.expectedPackageSha256 && digest !== options.expectedPackageSha256) throw new Error('loaded gbrain package content hash mismatch');
  if (!sha && !options.expectedPackageSha256) throw new Error('archive installation requires a preregistered verified package content hash');
  if ((options.requireClean ?? true) && dirty === true) throw new Error('loaded product checkout is dirty');
  const env = options.env ?? process.env;
  const bindings = {} as ResolvedRegressionProduct['bindings'];
  for (const key of ['package', 'deep_import', 'GBRAIN_SRC', 'GBRAIN_REPO'] as const) {
    const configured = key === 'GBRAIN_SRC' || key === 'GBRAIN_REPO' ? env[key] : undefined;
    let path = realpathSync(configured ?? packagePath);
    if (key === 'GBRAIN_SRC' && path === join(packagePath, 'src')) path = packagePath;
    if (path !== packagePath) throw new Error(`${key} resolves to another product tree`);
    bindings[key] = { path, sha, tree, package_sha256: digest };
  }
  return {
    declared_pin: declared.dependencies.gbrain, package_version: pkg.version, package_path: packagePath,
    product_sha: sha, product_tree: tree, package_sha256: digest, dirty, bindings,
  };
}
