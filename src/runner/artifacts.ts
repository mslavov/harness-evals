import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redactJson, type Redaction } from '../redaction.js';
import type { AgentEventsSummary } from '../events/types.js';
import type { WorkspaceDiff } from '../workspace/diff.js';
import type { TestRunResult } from './result.js';

let runCounter = 0;

export function buildRunDir(artifactRoot: string, caseId: string, agentName: string): string {
  return join(artifactRoot, `${sanitizePathPart(caseId)}-${sanitizePathPart(agentName)}-${timestamp()}-${runCounter++}`);
}

export async function writeEventsSummary(path: string, events: AgentEventsSummary, redactions: readonly Redaction[]): Promise<void> {
  await writeJson(path, redactJson(events, redactions));
}

export async function writeWorkspaceDiff(path: string, diff: WorkspaceDiff): Promise<void> {
  await writeJson(path, diff);
}

export async function writeRunResult(path: string, result: TestRunResult, redactions: readonly Redaction[]): Promise<void> {
  await writeJson(path, redactJson(result, redactions));
}

export async function writeOutputSummary(outputRoot: string, results: TestRunResult[], redactions: readonly Redaction[]): Promise<string> {
  const outputPath = join(outputRoot, 'latest', 'results.json');
  await writeJson(outputPath, redactJson({ pass: results.every((result) => result.pass), results }, redactions));
  return outputPath;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
