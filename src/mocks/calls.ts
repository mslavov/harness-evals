import { readFile } from 'node:fs/promises';
import type { MockRuntimePlan } from '../adapters/types.js';
import type { MockCallRecord } from './types.js';

export async function readMockCallLogs(runtime: MockRuntimePlan | undefined): Promise<MockCallRecord[]> {
  if (!runtime || runtime.callLogPaths.length === 0) return [];
  const calls: MockCallRecord[] = [];

  for (const path of runtime.callLogPaths) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw new Error(`Failed to read mock call log ${path}: ${errorMessage(error)}`);
    }

    for (const [index, line] of raw.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        calls.push(normalizeMockCall(JSON.parse(line) as unknown));
      } catch (error) {
        throw new Error(`Invalid mock call record in ${path}:${index + 1}: ${errorMessage(error)}`);
      }
    }
  }

  return calls.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function strictMockFailures(calls: readonly MockCallRecord[]): MockCallRecord[] {
  return calls.filter((call) => call.strict && !call.matched);
}

export function summarizeMockCalls(calls: readonly MockCallRecord[]): Record<string, unknown> {
  return {
    total: calls.length,
    matched: calls.filter((call) => call.matched).length,
    unmatched: calls.filter((call) => !call.matched).length,
    cli: calls.filter((call) => call.surface === 'cli').length,
    mcp: calls.filter((call) => call.surface === 'mcp').length,
  };
}

function normalizeMockCall(value: unknown): MockCallRecord {
  if (!isRecord(value)) throw new Error('record must be an object');
  const surface = value.surface;
  if (surface !== 'cli' && surface !== 'mcp') throw new Error('record.surface must be cli or mcp');
  if (typeof value.tool !== 'string') throw new Error('record.tool must be a string');
  if (typeof value.matched !== 'boolean') throw new Error('record.matched must be a boolean');
  if (typeof value.strict !== 'boolean') throw new Error('record.strict must be a boolean');
  if (typeof value.timestamp !== 'string') throw new Error('record.timestamp must be a string');
  const input = isRecord(value.input) ? value.input : {};
  const fixtureName = readOptionalString(value.fixtureName);
  const error = readOptionalString(value.error);
  return {
    surface,
    name: value.tool,
    tool: value.tool,
    input,
    args: input,
    matched: value.matched,
    strict: value.strict,
    timestamp: value.timestamp,
    command: readOptionalString(value.command),
    serverName: readOptionalString(value.serverName),
    fixtureName,
    fixture: fixtureName,
    fixturePath: readOptionalString(value.fixturePath),
    ruleId: readOptionalString(value.ruleId),
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : undefined,
    error,
    isError: Boolean(error),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
