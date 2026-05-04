import { join } from 'node:path';

let runCounter = 0;

export function buildRunDir(artifactRoot: string, caseId: string, agentName: string): string {
  return join(artifactRoot, `${sanitizePathPart(caseId)}-${sanitizePathPart(agentName)}-${timestamp()}-${runCounter++}`);
}

function sanitizePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
