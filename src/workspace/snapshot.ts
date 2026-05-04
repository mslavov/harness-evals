import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWorkspaceIgnored, normalizeWorkspacePath } from './ignore.js';

export type WorkspaceSnapshot = Record<string, string>;

export async function snapshotWorkspace(rootDir: string, ignore: readonly string[] = []): Promise<WorkspaceSnapshot> {
  const files: WorkspaceSnapshot = {};
  await walk(rootDir, '', files, ignore);
  return files;
}

async function walk(currentDir: string, relativeDir: string, files: WorkspaceSnapshot, ignore: readonly string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = normalizeWorkspacePath(relativeDir ? join(relativeDir, entry.name) : entry.name);
    if (isWorkspaceIgnored(relativePath, ignore)) continue;

    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, relativePath, files, ignore);
    } else if (entry.isFile()) {
      const content = await readFile(absolutePath);
      files[relativePath] = createHash('sha256').update(content).digest('hex');
    }
  }
}

