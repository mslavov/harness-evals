import type { AssertionConfig, JudgeInputRef, LlmJudgeAssertionConfig } from '../config/schema.js';
import type { JudgeRecord, JudgeRequest, JudgeResult } from '../judge/types.js';
import { redactJson, redactString } from '../redaction.js';
import type { AssertionContext, AssertionResult, AssertionRunner, AssertionRunOptions } from './types.js';

export const builtInAssertions: Record<string, AssertionRunner> = {
  exitCode,
  contains,
  notContains,
  toolCalled,
  mockCalled,
  noToolErrors,
  workspaceDiff,
  settingsDrivenSetup,
};

export async function runAssertions(configs: AssertionConfig[], context: AssertionContext, options: AssertionRunOptions = {}): Promise<AssertionResult[]> {
  const resultsByConfig = new Map<AssertionConfig, AssertionResult>();
  const nonJudgeConfigs = configs.filter((config) => config.type !== 'llmJudge');
  const judgeConfigs = configs.filter(isLlmJudgeConfig);
  const completed: AssertionResult[] = [];

  for (const config of nonJudgeConfigs) {
    const runner = builtInAssertions[config.type];
    const result = runner
      ? await runner(config, context)
      : assertionResult(config, false, `Unknown assertion type: ${config.type}`);
    resultsByConfig.set(config, result);
    completed.push(result);
  }

  for (const config of judgeConfigs) {
    const result = await llmJudge(config, { ...context, assertions: [...completed] }, options);
    resultsByConfig.set(config, result);
    completed.push(result);
  }

  return configs.map((config) => resultsByConfig.get(config) ?? assertionResult(config, false, `Assertion was not evaluated: ${config.type}`));
}

function exitCode(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const expected = readNumber(config.equals, 0);
  const pass = context.exitCode === expected;
  return assertionResult(
    config,
    pass,
    pass ? `Exit code was ${expected}` : `Expected exit code ${expected}, got ${String(context.exitCode)}`,
    { expected, actual: context.exitCode },
  );
}

function contains(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const value = readString(config.value);
  const pass = value ? context.output.includes(value) : false;
  return assertionResult(
    config,
    pass,
    pass ? `Output contained ${JSON.stringify(value)}` : `Output did not contain ${JSON.stringify(value)}`,
    { value },
  );
}

function notContains(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const value = readString(config.value);
  const pass = value ? !context.output.includes(value) : false;
  return assertionResult(
    config,
    pass,
    pass ? `Output did not contain ${JSON.stringify(value)}` : `Output contained ${JSON.stringify(value)}`,
    { value },
  );
}

function toolCalled(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const name = readString(config.name);
  if (!name) return assertionResult(config, false, 'toolCalled requires name');

  const min = readNumber(config.min, 1);
  const max = typeof config.max === 'number' ? config.max : undefined;
  const matching = context.events.toolCalls.filter((call) => matchesToolName(call.name, name));
  const metadata = { name, min, max, count: matching.length };

  if (matching.length < min) {
    return assertionResult(config, false, `Expected ${name} at least ${min} time(s), got ${matching.length}`, metadata);
  }
  if (max !== undefined && matching.length > max) {
    return assertionResult(config, false, `Expected ${name} at most ${max} time(s), got ${matching.length}`, metadata);
  }

  const argsContain = readStringArray(config.argsContain);
  const serializedArgs = matching.map((call) => JSON.stringify(call.args ?? null)).join('\n');
  const missing = argsContain.filter((needle) => !serializedArgs.includes(needle));
  if (missing.length > 0) {
    return assertionResult(config, false, `Tool ${name} args did not contain: ${missing.join(', ')}`, { ...metadata, missing });
  }

  return assertionResult(config, true, `Tool ${name} was called ${matching.length} time(s)`, metadata);
}

function mockCalled(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const name = readString(config.name);
  if (!name) return assertionResult(config, false, 'mockCalled requires name');

  const surface = readString(config.surface);
  const min = readNumber(config.min, 1);
  const max = typeof config.max === 'number' ? config.max : undefined;
  const expectedMatched = typeof config.matched === 'boolean' ? config.matched : undefined;
  const calls = context.mockCalls ?? context.events.mockCalls ?? [];
  const matching = calls.filter((call) => {
    if (surface && call.surface !== surface) return false;
    if (expectedMatched !== undefined && call.matched !== expectedMatched) return false;
    return matchesToolName(call.name, name);
  });
  const metadata = { name, surface, min, max, matched: expectedMatched, count: matching.length };

  if (matching.length < min) {
    return assertionResult(config, false, `Expected mock ${name} at least ${min} time(s), got ${matching.length}`, metadata);
  }
  if (max !== undefined && matching.length > max) {
    return assertionResult(config, false, `Expected mock ${name} at most ${max} time(s), got ${matching.length}`, metadata);
  }

  const argsContain = readStringArray(config.argsContain);
  const serializedArgs = matching.map((call) => JSON.stringify(call.args ?? null)).join('\n');
  const missing = argsContain.filter((needle) => !serializedArgs.includes(needle));
  if (missing.length > 0) {
    return assertionResult(config, false, `Mock ${name} args did not contain: ${missing.join(', ')}`, { ...metadata, missing });
  }

  return assertionResult(config, true, `Mock ${name} was called ${matching.length} time(s)`, metadata);
}

function noToolErrors(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const failures = context.events.toolCalls.filter((call) => call.isError === true);
  if (failures.length > 0) {
    return assertionResult(config, false, `Tool errors recorded: ${failures.map((call) => call.name).join(', ')}`, { failures });
  }
  return assertionResult(config, true, 'No tool errors recorded', { failures: [] });
}

function workspaceDiff(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const added = [...context.workspace.added].sort();
  const changed = [...context.workspace.changed].sort();
  const deleted = [...context.workspace.deleted].sort();
  const actual = [...added, ...changed, ...deleted].sort();

  const changedFiles = readStringArray(config.changedFiles, true);
  if (changedFiles) {
    const expected = [...changedFiles].sort();
    if (!sameArray(actual, expected)) {
      return assertionResult(config, false, `Expected workspace diff ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, { expected, actual });
    }
  }

  const addedFiles = readStringArray(config.addedFiles, true);
  if (addedFiles && !sameArray(added, addedFiles)) {
    return assertionResult(config, false, `Expected added files ${JSON.stringify(addedFiles)}, got ${JSON.stringify(added)}`, { expected: addedFiles, actual: added });
  }

  const deletedFiles = readStringArray(config.deletedFiles, true);
  if (deletedFiles && !sameArray(deleted, deletedFiles)) {
    return assertionResult(config, false, `Expected deleted files ${JSON.stringify(deletedFiles)}, got ${JSON.stringify(deleted)}`, { expected: deletedFiles, actual: deleted });
  }

  const minChanged = readOptionalNumber(config.minChanged);
  if (minChanged !== undefined && actual.length < minChanged) {
    return assertionResult(config, false, `Expected at least ${minChanged} changed file(s), got ${actual.length}`, { minChanged, actual });
  }

  const maxChanged = readOptionalNumber(config.maxChanged);
  if (maxChanged !== undefined && actual.length > maxChanged) {
    return assertionResult(config, false, `Expected at most ${maxChanged} changed file(s), got ${actual.length}`, { maxChanged, actual });
  }

  return assertionResult(config, true, 'Workspace diff matched expectations', { added, changed, deleted });
}

function settingsDrivenSetup(config: AssertionConfig, context: AssertionContext): AssertionResult {
  const settings = readRecord(context.metadata.settings);
  const templates = settings ? readStringArray(settings.templates) : [];
  const sources = settings ? readStringArray(settings.sources) : [];
  const hasGeneratedSettings = typeof settings?.globalSettingsPath === 'string' || typeof settings?.projectSettingsPath === 'string';
  const argv = readStringArray(readRecord(context.metadata.agent)?.argv);

  if (templates.length === 0 && sources.length === 0 && !hasGeneratedSettings) {
    return assertionResult(config, false, 'No generated settings source was recorded', { templates, sources, hasGeneratedSettings });
  }

  if (argv.includes('-e') || argv.includes('--no-extensions')) {
    return assertionResult(config, false, 'Agent command used explicit -e or --no-extensions', { argv });
  }

  return assertionResult(config, true, 'Setup was settings-driven', { templates, sources, hasGeneratedSettings });
}

async function llmJudge(config: LlmJudgeAssertionConfig, context: AssertionContext, options: AssertionRunOptions): Promise<AssertionResult> {
  const resolved = resolveJudgeRequest(config, context, options);
  if (!resolved.ok) {
    const record = judgeRecord(config, false, resolved.reason, { error: resolved.reason });
    await options.onJudgeRecord?.(record);
    return assertionResult(config, false, resolved.reason, { error: resolved.reason }, undefined, config.threshold);
  }

  try {
    if (!options.judgeRunner) throw new Error('llmJudge requires a configured judge runner');
    const judgeResult = validateJudgeResult(await options.judgeRunner(resolved.request));
    const pass = judgeResult.score >= config.threshold && judgeResult.pass !== false;
    const reason = judgeResult.pass === false && judgeResult.score >= config.threshold
      ? `Judge explicitly failed: ${judgeResult.reason}`
      : judgeResult.reason;
    const metadata = buildJudgeAssertionMetadata(resolved.request, judgeResult.metadata);
    await options.onJudgeRecord?.({
      id: config.id,
      assertionId: config.id,
      type: 'llmJudge',
      provider: resolved.request.provider,
      model: resolved.request.model,
      threshold: config.threshold,
      score: judgeResult.score,
      pass,
      reason,
      prompt: resolved.request.prompt,
      inputs: resolved.request.inputs,
      metadata,
    });
    return assertionResult(config, pass, reason, metadata, judgeResult.score, config.threshold);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await options.onJudgeRecord?.({
      id: config.id,
      assertionId: config.id,
      type: 'llmJudge',
      provider: resolved.request.provider,
      model: resolved.request.model,
      threshold: config.threshold,
      pass: false,
      reason,
      prompt: resolved.request.prompt,
      inputs: resolved.request.inputs,
      error: reason,
    });
    return assertionResult(config, false, reason, { provider: resolved.request.provider, model: resolved.request.model, error: reason }, undefined, config.threshold);
  }
}

function resolveJudgeRequest(
  config: LlmJudgeAssertionConfig,
  context: AssertionContext,
  options: AssertionRunOptions,
): { ok: true; request: JudgeRequest } | { ok: false; reason: string } {
  const provider = config.judge.provider ?? options.judgeDefaults?.provider;
  const model = config.judge.model ?? options.judgeDefaults?.model;
  const apiKeyEnv = config.judge.apiKeyEnv ?? options.judgeDefaults?.apiKeyEnv;
  const hasExplicitJudgeConfig = Boolean(provider || model || apiKeyEnv);
  if (hasExplicitJudgeConfig) {
    if (!provider) return { ok: false, reason: 'llmJudge requires judge.provider or top-level judge.provider when explicit judge config is used' };
    if (!model) return { ok: false, reason: 'llmJudge requires judge.model or top-level judge.model when explicit judge config is used' };
    if (!apiKeyEnv) return { ok: false, reason: 'llmJudge requires judge.apiKeyEnv or top-level judge.apiKeyEnv when explicit judge config is used' };
  }

  const inputs = redactJson(buildJudgeInputs(config.judge.inputs, context), options.redactions ?? []) as Partial<Record<JudgeInputRef, unknown>>;
  const prompt = redactString(buildJudgePrompt(config, inputs, config.judge.promptTemplate ?? options.judgeDefaults?.promptTemplate), options.redactions ?? []);
  return {
    ok: true,
    request: {
      assertionId: config.id,
      provider,
      model,
      apiKeyEnv,
      temperature: config.judge.temperature ?? options.judgeDefaults?.temperature,
      rubric: config.judge.rubric,
      threshold: config.threshold,
      inputs,
      prompt,
    },
  };
}

function buildJudgeInputs(refs: JudgeInputRef[], context: AssertionContext): Partial<Record<JudgeInputRef, unknown>> {
  const inputs: Partial<Record<JudgeInputRef, unknown>> = {};
  for (const ref of refs) {
    switch (ref) {
      case 'finalOutput':
        inputs.finalOutput = context.output;
        break;
      case 'stdout':
        inputs.stdout = context.stdout ?? '';
        break;
      case 'stderr':
        inputs.stderr = context.stderr ?? '';
        break;
      case 'events':
        inputs.events = context.events;
        break;
      case 'toolCalls':
        inputs.toolCalls = context.events.toolCalls;
        break;
      case 'mockCalls':
        inputs.mockCalls = context.mockCalls ?? context.events.mockCalls ?? [];
        break;
      case 'assertions':
        inputs.assertions = context.assertions ?? [];
        break;
      case 'workspaceDiff':
        inputs.workspaceDiff = context.workspace;
        break;
      case 'cost':
        inputs.cost = context.events.cost;
        break;
    }
  }
  return inputs;
}

function buildJudgePrompt(config: LlmJudgeAssertionConfig, inputs: Partial<Record<JudgeInputRef, unknown>>, template?: string): string {
  const inputJson = JSON.stringify(inputs, null, 2);
  if (template) {
    return template
      .replaceAll('{{rubric}}', config.judge.rubric)
      .replaceAll('{{inputs}}', inputJson)
      .replaceAll('{rubric}', config.judge.rubric)
      .replaceAll('{inputs}', inputJson);
  }

  return `Evaluate the agent result using this rubric:\n${config.judge.rubric}\n\nInputs:\n${inputJson}\n\nReturn only JSON with this shape: {"score": number between 0 and 1, "pass": optional boolean, "reason": string, "metadata": optional object}.`;
}

function validateJudgeResult(result: JudgeResult): JudgeResult {
  if (typeof result.score !== 'number' || !Number.isFinite(result.score)) throw new Error('Judge result score must be a number');
  if (result.score < 0 || result.score > 1) throw new Error('Judge result score must be between 0 and 1');
  if (typeof result.reason !== 'string' || !result.reason.trim()) throw new Error('Judge result reason must be a non-empty string');
  if (result.pass !== undefined && typeof result.pass !== 'boolean') throw new Error('Judge result pass must be a boolean when provided');
  if (result.metadata !== undefined && !isRecord(result.metadata)) throw new Error('Judge result metadata must be an object when provided');
  return result;
}

function buildJudgeAssertionMetadata(request: JudgeRequest, judgeMetadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const usage = readRecord(judgeMetadata?.usage);
  const cost = readRecord(judgeMetadata?.cost);
  return {
    provider: request.provider,
    model: request.model,
    usage,
    cost,
    judge: judgeMetadata,
  };
}

function judgeRecord(config: LlmJudgeAssertionConfig, pass: boolean, reason: string, metadata?: Record<string, unknown>): JudgeRecord {
  return {
    id: config.id,
    assertionId: config.id,
    type: 'llmJudge',
    threshold: config.threshold,
    pass,
    reason,
    metadata,
    error: pass ? undefined : reason,
  };
}

function assertionResult(config: AssertionConfig, pass: boolean, reason: string, metadata?: Record<string, unknown>, score = pass ? 1 : 0, threshold?: number): AssertionResult {
  return {
    id: typeof config.id === 'string' ? config.id : undefined,
    type: config.type,
    pass,
    required: readRequired(config),
    score,
    threshold,
    reason,
    metadata,
  };
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

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLlmJudgeConfig(config: AssertionConfig): config is LlmJudgeAssertionConfig {
  return config.type === 'llmJudge';
}

function matchesToolName(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`__${expected}`);
}

function sameArray(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}
