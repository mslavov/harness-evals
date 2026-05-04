import type { AssertionConfig } from '../config/schema.js';
import type { AssertionContext, AssertionResult, AssertionRunner } from './types.js';

export const builtInAssertions: Record<string, AssertionRunner> = {
  exitCode,
  contains,
  notContains,
  toolCalled,
  noToolErrors,
  workspaceDiff,
  settingsDrivenSetup,
  piExitedSuccessfully: exitCode,
};

export async function runAssertions(configs: AssertionConfig[], context: AssertionContext): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const config of configs) {
    const runner = builtInAssertions[config.type];
    if (!runner) {
      results.push({ type: config.type, pass: false, reason: `Unknown assertion type: ${config.type}`, required: readRequired(config) });
      continue;
    }
    results.push(await runner(config, context));
  }
  return results;
}

function exitCode(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const expected = readNumber(config.equals, 0);
  const pass = context.exitCode === expected;
  return {
    type: config.type,
    pass,
    reason: pass ? `Exit code was ${expected}` : `Expected exit code ${expected}, got ${String(context.exitCode)}`,
    required: readRequired(config),
  };
}

function contains(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const value = readString(config.value);
  const pass = value ? context.output.includes(value) : false;
  return {
    type: config.type,
    pass,
    reason: pass ? `Output contained ${JSON.stringify(value)}` : `Output did not contain ${JSON.stringify(value)}`,
    required: readRequired(config),
  };
}

function notContains(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const value = readString(config.value);
  const pass = value ? !context.output.includes(value) : false;
  return {
    type: config.type,
    pass,
    reason: pass ? `Output did not contain ${JSON.stringify(value)}` : `Output contained ${JSON.stringify(value)}`,
    required: readRequired(config),
  };
}

function toolCalled(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const name = readString(config.name);
  if (!name) return { type: config.type, pass: false, reason: 'toolCalled requires name', required: readRequired(config) };

  const min = readNumber(config.min, 1);
  const max = typeof config.max === 'number' ? config.max : undefined;
  const matching = context.events.toolCalls.filter((call) => matchesToolName(call.name, name));

  if (matching.length < min) {
    return { type: config.type, pass: false, reason: `Expected ${name} at least ${min} time(s), got ${matching.length}`, required: readRequired(config) };
  }
  if (max !== undefined && matching.length > max) {
    return { type: config.type, pass: false, reason: `Expected ${name} at most ${max} time(s), got ${matching.length}`, required: readRequired(config) };
  }

  const argsContain = readStringArray(config.argsContain);
  const serializedArgs = matching.map((call) => JSON.stringify(call.args ?? null)).join('\n');
  const missing = argsContain.filter((needle) => !serializedArgs.includes(needle));
  if (missing.length > 0) {
    return { type: config.type, pass: false, reason: `Tool ${name} args did not contain: ${missing.join(', ')}`, required: readRequired(config) };
  }

  return { type: config.type, pass: true, reason: `Tool ${name} was called ${matching.length} time(s)`, required: readRequired(config) };
}

function noToolErrors(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const failures = context.events.toolCalls.filter((call) => call.isError === true);
  if (failures.length > 0) {
    return {
      type: config.type,
      pass: false,
      reason: `Tool errors recorded: ${failures.map((call) => call.name).join(', ')}`,
      required: readRequired(config),
    };
  }
  return { type: config.type, pass: true, reason: 'No tool errors recorded', required: readRequired(config) };
}

function workspaceDiff(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const added = [...context.workspace.added].sort();
  const changed = [...context.workspace.changed].sort();
  const deleted = [...context.workspace.deleted].sort();

  const changedFiles = readStringArray(config.changedFiles, true);
  if (changedFiles) {
    const actual = [...added, ...changed, ...deleted].sort();
    const expected = [...changedFiles].sort();
    if (!sameArray(actual, expected)) {
      return { type: config.type, pass: false, reason: `Expected workspace diff ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, required: readRequired(config) };
    }
  }

  const addedFiles = readStringArray(config.addedFiles, true);
  if (addedFiles && !sameArray(added, addedFiles)) {
    return { type: config.type, pass: false, reason: `Expected added files ${JSON.stringify(addedFiles)}, got ${JSON.stringify(added)}`, required: readRequired(config) };
  }

  const deletedFiles = readStringArray(config.deletedFiles, true);
  if (deletedFiles && !sameArray(deleted, deletedFiles)) {
    return { type: config.type, pass: false, reason: `Expected deleted files ${JSON.stringify(deletedFiles)}, got ${JSON.stringify(deleted)}`, required: readRequired(config) };
  }

  return { type: config.type, pass: true, reason: 'Workspace diff matched expectations', required: readRequired(config) };
}

function settingsDrivenSetup(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const settings = readRecord(context.metadata.settings);
  const templates = settings ? readStringArray(settings.templates) : [];
  const sources = settings ? readStringArray(settings.sources) : [];
  const hasGeneratedSettings = typeof settings?.globalSettingsPath === 'string' || typeof settings?.projectSettingsPath === 'string';
  const argv = readStringArray(readRecord(context.metadata.agent)?.argv);

  if (templates.length === 0 && sources.length === 0 && !hasGeneratedSettings) {
    return { type: config.type, pass: false, reason: 'No generated settings source was recorded', required: readRequired(config) };
  }

  if (argv.includes('-e') || argv.includes('--no-extensions')) {
    return { type: config.type, pass: false, reason: 'Agent command used explicit -e or --no-extensions', required: readRequired(config) };
  }

  return { type: config.type, pass: true, reason: 'Setup was settings-driven', required: readRequired(config) };
}

function readRequired(config: AssertionConfig): boolean {
  return typeof config.required === 'boolean' ? config.required : true;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

function readStringArray(value: unknown, preserveUndefined?: false): string[];
function readStringArray(value: unknown, preserveUndefined: true): string[] | undefined;
function readStringArray(value: unknown, preserveUndefined = false): string[] | undefined {
  if (value === undefined && preserveUndefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').sort();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function matchesToolName(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`__${expected}`);
}

function sameArray(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}
