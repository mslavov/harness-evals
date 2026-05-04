import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import YAML from 'yaml';
import { resolveProjectPath } from '../config/paths.js';
import type { MockFixture, MockRule, MockSurface } from './types.js';

export function resolveMockFixturePath(
  mocksRoot: string,
  projectRoot: string,
  surface: MockSurface,
  fixture: string,
  field: string,
): string {
  if (hasTraversalSegment(fixture)) throw new Error(`Path escapes project root (${field}: ${fixture})`);
  const path = isFixtureName(fixture) ? join(mocksRoot, surface, withYamlExtension(fixture)) : withYamlExtension(fixture);
  return resolveProjectPath(projectRoot, path, field);
}

export async function loadMockFixture(path: string): Promise<MockFixture> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to read mock fixture ${path}: ${errorMessage(error)}`);
  }

  return { ...readMockFixture(parsed, path), sourcePath: path };
}

function readMockFixture(value: unknown, path: string): Omit<MockFixture, 'sourcePath'> {
  if (!isRecord(value)) throw new Error(`Mock fixture must contain an object: ${path}`);
  assertKnownKeys(value, ['name', 'description', 'mocks'], `mock fixture ${path}`);
  const name = readString(value.name, `mock fixture ${path}.name`);
  if (!name) throw new Error(`mock fixture ${path}.name is required`);
  const description = readString(value.description, `mock fixture ${path}.description`);
  if (!Array.isArray(value.mocks)) throw new Error(`mock fixture ${path}.mocks must be an array`);
  return {
    name,
    description,
    mocks: value.mocks.map((entry, index) => readMockRule(entry, `mock fixture ${path}.mocks[${index}]`)),
  };
}

function readMockRule(value: unknown, field: string): MockRule {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['id', 'tool', 'match', 'response', 'stdout', 'stderr', 'exitCode', 'delayMs'], field);
  const tool = readString(value.tool, `${field}.tool`);
  if (!tool) throw new Error(`${field}.tool is required`);

  const rule: MockRule = { tool };
  const id = readString(value.id, `${field}.id`);
  if (id) rule.id = id;
  const match = readMatch(value.match, `${field}.match`);
  if (match) rule.match = match;
  if ('response' in value) rule.response = value.response;
  const stdout = readString(value.stdout, `${field}.stdout`);
  if (stdout !== undefined) rule.stdout = stdout;
  const stderr = readString(value.stderr, `${field}.stderr`);
  if (stderr !== undefined) rule.stderr = stderr;
  const exitCode = readNumber(value.exitCode, `${field}.exitCode`);
  if (exitCode !== undefined) rule.exitCode = exitCode;
  const delayMs = readNumber(value.delayMs, `${field}.delayMs`);
  if (delayMs !== undefined) rule.delayMs = delayMs;
  return rule;
}

function readMatch(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (typeof child !== 'string') throw new Error(`${field}.${key} must be a string`);
    return [key, child];
  }));
}

function readString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a number`);
  return value;
}

function withYamlExtension(path: string): string {
  return extname(path) ? path : `${path}.yaml`;
}

function isFixtureName(value: string): boolean {
  return !value.startsWith('.') && !value.includes('/') && !value.includes('\\');
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`Unknown ${field} key: ${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
