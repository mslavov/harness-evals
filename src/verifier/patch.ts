import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { HiddenPatchResult, ModelPatchArtifact } from './types.js';

export async function captureModelPatch(input: {
  baseWorkspaceDir: string;
  workspaceDir: string;
  outputPath: string;
}): Promise<{ artifact: ModelPatchArtifact; content: string }> {
  const result = spawnSync('diff', ['-ruN', input.baseWorkspaceDir, input.workspaceDir], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || `diff exited with code ${result.status}`);

  const content = normalizeDiffPaths(result.stdout, input.baseWorkspaceDir, input.workspaceDir);
  return {
    artifact: {
      path: input.outputPath,
      bytes: Buffer.byteLength(content),
      empty: content.length === 0,
    },
    content,
  };
}

export async function applyHiddenPatch(workspaceDir: string, patchPath: string): Promise<HiddenPatchResult> {
  const startedAt = Date.now();
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: workspaceDir, encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const error = result.error?.message ?? (result.status === 0 ? undefined : stderr || `git apply exited with code ${result.status}`);

  return {
    path: patchPath,
    applied: !error,
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
    error,
  };
}

function normalizeDiffPaths(diff: string, baseWorkspaceDir: string, workspaceDir: string): string {
  const base = stripTrailingSlash(baseWorkspaceDir);
  const workspace = stripTrailingSlash(workspaceDir);
  return diff.split('\n').map((line) => {
    if (line.startsWith(`diff -ruN ${base}/`)) return normalizeDiffHeader(line, base, workspace);
    if (line.startsWith(`--- ${base}/`)) return line.replace(`--- ${base}/`, '--- a/');
    if (line.startsWith(`+++ ${workspace}/`)) return line.replace(`+++ ${workspace}/`, '+++ b/');
    if (line.startsWith(`Only in ${base}`) || line.startsWith(`Only in ${workspace}`)) return line;
    return line;
  }).join('\n');
}

function normalizeDiffHeader(line: string, base: string, workspace: string): string {
  const prefix = `diff -ruN ${base}/`;
  const rest = line.slice(prefix.length);
  const separator = ` ${workspace}/`;
  const separatorIndex = rest.indexOf(separator);
  if (separatorIndex === -1) return line;
  const left = rest.slice(0, separatorIndex);
  const right = rest.slice(separatorIndex + separator.length);
  return `diff -ruN a/${left} b/${right}`;
}

function stripTrailingSlash(path: string): string {
  return path === dirname(path) ? path : path.replace(/[\\/]+$/, '');
}
