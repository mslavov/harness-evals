import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isWorkspaceIgnored, normalizeWorkspacePath } from './ignore.js';

export interface CopyWorkspaceOptions {
  ignore?: string[];
}

export async function copyWorkspace(sourceDir: string, workspaceDir: string, options: CopyWorkspaceOptions = {}): Promise<void> {
  const ignore = options.ignore ?? [];
  const filter = (source: string) => {
    const rel = normalizeWorkspacePath(relative(sourceDir, source));
    return !isWorkspaceIgnored(rel, ignore);
  };

  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(dirname(workspaceDir), { recursive: true });

  if (isInside(sourceDir, workspaceDir)) {
    const tempRoot = await mkdtemp(join(tmpdir(), 'harness-evals-workspace-'));
    const tempWorkspace = join(tempRoot, 'workspace');
    try {
      await cp(sourceDir, tempWorkspace, { recursive: true, filter });
      await cp(tempWorkspace, workspaceDir, { recursive: true });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
    return;
  }

  await cp(sourceDir, workspaceDir, { recursive: true, filter });
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

