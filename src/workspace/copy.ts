import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

export interface CopyWorkspaceOptions {
  ignore?: string[];
}

export async function copyWorkspace(sourceDir: string, workspaceDir: string, options: CopyWorkspaceOptions = {}): Promise<void> {
  const ignore = options.ignore ?? [];
  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(dirname(workspaceDir), { recursive: true });
  await cp(sourceDir, workspaceDir, {
    recursive: true,
    filter: (source) => {
      const rel = normalizePath(relative(sourceDir, source));
      return !isIgnored(rel, ignore);
    },
  });
}

function isIgnored(path: string, patterns: readonly string[]): boolean {
  if (!path) return false;
  const normalized = normalizePath(path);
  const parts = normalized.split('/');

  return patterns.some((pattern) => {
    const normalizedPattern = normalizePath(pattern).replace(/^\/+|\/+$/g, '');
    if (!normalizedPattern) return false;
    if (!normalizedPattern.includes('*') && !normalizedPattern.includes('/')) {
      return parts.includes(normalizedPattern);
    }
    if (!normalizedPattern.includes('*')) {
      return normalized === normalizedPattern || normalized.startsWith(`${normalizedPattern}/`);
    }
    const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*')}(?:/.*)?$`);
    return regex.test(normalized);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}

function normalizePath(path: string): string {
  return path.split('\\').join('/');
}
