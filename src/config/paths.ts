import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export async function findHarnessConfig(cwd: string): Promise<string> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, 'harness-evals.yaml');
    if (await pathExists(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Could not find harness-evals.yaml from ${cwd}`);
}

export function resolveProjectPath(projectRoot: string, path: string, field: string): string {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  assertInside(projectRoot, resolved, `${field}: ${path}`);
  return resolved;
}

export function resolveOptionalProjectPath(projectRoot: string, path: string | undefined, field: string): string | undefined {
  return path ? resolveProjectPath(projectRoot, path, field) : undefined;
}

export function expandTrustedPath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function resolveTrustedPath(projectRoot: string, path: string): string {
  const expanded = expandTrustedPath(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(projectRoot, expanded);
}

export function toContainerPath(containerRoot: string, relativePath: string): string {
  const normalized = relativePath.split('\\').join('/').replace(/^\/+/, '');
  return `${containerRoot.replace(/\/+$/, '')}/${normalized}`;
}

export function relativePosix(from: string, to: string): string {
  return relative(from, to).split('\\').join('/');
}

export function assertInside(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(`Path escapes project root (${label})`);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
