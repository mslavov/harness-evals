import type { WorkspaceSnapshot } from './snapshot.js';

export interface WorkspaceDiff {
  added: string[];
  changed: string[];
  deleted: string[];
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff {
  const beforePaths = new Set(Object.keys(before));
  const afterPaths = new Set(Object.keys(after));

  const added = [...afterPaths].filter((path) => !beforePaths.has(path));
  const deleted = [...beforePaths].filter((path) => !afterPaths.has(path));
  const changed = [...afterPaths].filter((path) => beforePaths.has(path) && before[path] !== after[path]);

  return {
    added: added.sort(),
    changed: changed.sort(),
    deleted: deleted.sort(),
  };
}
