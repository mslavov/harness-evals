import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import fg from 'fast-glob';
import YAML from 'yaml';
import { safeStepId } from '../step-id.js';
import { resolveAgentExtends, withHarnessDefaults, type HarnessConfigOverride } from './merge.js';
import { findHarnessConfig, resolveOptionalProjectPath, resolveProjectPath } from './paths.js';
import type {
  AdapterDeclaration,
  AgentConfig,
  AgentsSelection,
  AssertionConfig,
  HarnessConfig,
  JudgeAssertionDefinition,
  JudgeDefaults,
  LoadedHarnessConfig,
  MockConfig,
  OutputConfig,
  OutputProviderConfig,
  ProjectScoringConfig,
  ScoreType,
  TestCase,
  TestCaseMockConfig,
  TestCaseStepDefinition,
  VisualizationConfig,
  VisualizationFormat,
} from './schema.js';

export interface LoadHarnessConfigOptions {
  cwd?: string;
  configPath?: string;
}

const BUILT_IN_PROVIDER_TYPES = new Set(['file']);
const VISUALIZATION_FORMATS = new Set<VisualizationFormat>(['html', 'json', 'csv']);
const SCORING_TYPES = new Set<ScoreType>(['assertionPassRate', 'judgeScore', 'latency', 'cost', 'tokenUsage']);
const METRIC_SCORING_TYPES = new Set<ScoreType>(['latency', 'cost', 'tokenUsage']);
const SCORE_TARGETS = new Set(['maximize', 'minimize']);
const JUDGE_INPUT_REFS = new Set(['finalOutput', 'stdout', 'stderr', 'events', 'toolCalls', 'mockCalls', 'assertions', 'workspaceDiff', 'cost']);

const ASSERTION_KEYS: Record<string, readonly string[]> = {
  exitCode: ['id', 'type', 'required', 'equals'],
  contains: ['id', 'type', 'required', 'value'],
  notContains: ['id', 'type', 'required', 'value'],
  toolCalled: ['id', 'type', 'required', 'name', 'min', 'max', 'argsContain'],
  mockCalled: ['id', 'type', 'required', 'name', 'surface', 'min', 'max', 'argsContain', 'matched'],
  noToolErrors: ['id', 'type', 'required'],
  workspaceDiff: ['id', 'type', 'required', 'changedFiles', 'addedFiles', 'deletedFiles', 'minChanged', 'maxChanged'],
  settingsDrivenSetup: ['id', 'type', 'required'],
  llmJudge: ['id', 'type', 'required', 'threshold', 'judge'],
};

export async function loadHarnessConfig(options: LoadHarnessConfigOptions = {}): Promise<LoadedHarnessConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath ? resolve(cwd, options.configPath) : await findHarnessConfig(cwd);
  const projectRoot = dirname(configPath);
  const rawConfig = await readYamlFile(configPath);
  const interpolated = interpolateEnv(rawConfig);
  const config = normalizeHarnessConfig(withHarnessDefaults(readHarnessConfig(interpolated)), projectRoot);
  const testCases = await loadTestCases(config.tests, projectRoot, config.mocks);
  validateJudgeAssertionDefaults(testCases, config.judge);

  return {
    ...config,
    projectRoot,
    configPath,
    testCases,
  };
}

export async function writeStarterConfig(path: string): Promise<void> {
  const projectRoot = dirname(path);
  const testPath = join(projectRoot, 'evals', 'tests', 'starter-smoke.yaml');

  await mkdir(projectRoot, { recursive: true });
  await mkdir(dirname(testPath), { recursive: true });
  await writeFile(path, `${STARTER_CONFIG.trim()}\n`);
  if (!existsSync(testPath)) await writeFile(testPath, `${STARTER_TEST_CASE.trim()}\n`);
}

async function loadTestCases(patterns: string[], projectRoot: string, mocks: MockConfig): Promise<TestCase[]> {
  const cases: TestCase[] = [];

  for (const pattern of patterns) {
    validateProjectRelativeGlob(pattern, `tests ${pattern}`);
    const matches = await fg(pattern, { cwd: projectRoot, absolute: true, onlyFiles: true });
    for (const match of matches.sort()) {
      resolveProjectPath(projectRoot, match, `tests ${pattern}`);
      cases.push(await loadTestCaseFile(match, projectRoot, mocks));
    }
  }

  return cases;
}

async function loadTestCaseFile(path: string, projectRoot: string, mocks: MockConfig): Promise<TestCase> {
  const raw = await readYamlFile(path);
  const parsed = readTestCase(interpolateEnv(raw), path);
  return normalizeTestCase(parsed, projectRoot, path, mocks);
}

async function readYamlFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return YAML.parse(raw) as unknown;
}

function readHarnessConfig(value: unknown): HarnessConfigOverride {
  if (!isRecord(value)) throw new Error('harness-evals.yaml must contain an object');
  const version = value.version ?? 1;
  if (version !== 1) throw new Error(`Unsupported harness config version: ${String(version)}`);

  return {
    version: 1,
    artifactRoot: readOptionalString(value.artifactRoot, 'artifactRoot'),
    outputRoot: readOptionalString(value.outputRoot, 'outputRoot'),
    workspace: readOptionalRecord(value.workspace, 'workspace') as Partial<HarnessConfig['workspace']> | undefined,
    docker: readOptionalRecord(value.docker, 'docker') as Partial<HarnessConfig['docker']> | undefined,
    agents: readAgents(value.agents),
    tests: readTests(value.tests),
    adapters: readAdapters(value.adapters),
    mocks: readMockDefaults(value.mocks),
    output: readOutputConfig(value.output),
    visualization: readVisualizationConfig(value.visualization),
    judge: readJudgeDefaults(value.judge),
    scoring: readScoringConfig(value.scoring),
  };
}

function normalizeHarnessConfig(config: HarnessConfig, projectRoot: string): HarnessConfig {
  validateAdapters(config.adapters, projectRoot);
  validateOutputProviders(config.output.providers, projectRoot);

  const outputProviders = config.output.providers.length > 0 ? config.output.providers : [{ type: 'file' }];

  return {
    ...config,
    artifactRoot: resolveProjectPath(projectRoot, config.artifactRoot, 'artifactRoot'),
    outputRoot: resolveProjectPath(projectRoot, config.outputRoot, 'outputRoot'),
    workspace: {
      ...config.workspace,
      source: resolveProjectPath(projectRoot, config.workspace.source, 'workspace.source'),
      fixture: resolveOptionalProjectPath(projectRoot, config.workspace.fixture, 'workspace.fixture'),
    },
    mocks: {
      ...config.mocks,
      root: resolveProjectPath(projectRoot, config.mocks.root, 'mocks.root'),
    },
    output: {
      providers: outputProviders,
    },
    agents: resolveAgentExtends(config.agents),
    tests: [...config.tests],
  };
}

function readAgents(value: unknown): Record<string, AgentConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('agents must be an object');

  const agents: Record<string, AgentConfig> = {};
  for (const [name, rawAgent] of Object.entries(value)) {
    if (!isRecord(rawAgent)) throw new Error(`agents.${name} must be an object`);
    const adapter = readOptionalString(rawAgent.adapter, `agents.${name}.adapter`);
    const parent = readOptionalString(rawAgent.extends, `agents.${name}.extends`);
    if (!adapter && !parent) throw new Error(`agents.${name}.adapter is required unless extends is set`);
    agents[name] = readAgentConfig(rawAgent, adapter ?? (parent ? undefined : 'command'), `agents.${name}`);
  }
  return agents;
}

function readAgentConfig(raw: Record<string, unknown>, fallbackAdapter: string | undefined, field: string): AgentConfig {
  const fields = readAgentFields(raw, field);
  return {
    ...fields,
    adapter: readOptionalString(raw.adapter, `${field}.adapter`) ?? (fallbackAdapter as string),
  };
}

function readAgentFields(raw: Record<string, unknown>, field: string): Partial<AgentConfig> {
  return {
    extends: readOptionalString(raw.extends, `${field}.extends`),
    label: readOptionalString(raw.label, `${field}.label`),
    command: readOptionalString(raw.command, `${field}.command`),
    args: readOptionalStringArray(raw.args, `${field}.args`),
    cwd: readOptionalString(raw.cwd, `${field}.cwd`),
    env: readOptionalStringArray(raw.env, `${field}.env`),
    envAllowlist: readOptionalStringArray(raw.envAllowlist, `${field}.envAllowlist`),
    timeoutMs: readOptionalNumber(raw.timeoutMs, `${field}.timeoutMs`),
    provider: readOptionalString(raw.provider, `${field}.provider`),
    providerEnv: readOptionalString(raw.providerEnv, `${field}.providerEnv`),
    model: readOptionalString(raw.model, `${field}.model`),
    modelEnv: readOptionalString(raw.modelEnv, `${field}.modelEnv`),
    apiKeyEnv: readOptionalString(raw.apiKeyEnv, `${field}.apiKeyEnv`),
    profile: readOptionalString(raw.profile, `${field}.profile`),
    outputFormat: readOptionalString(raw.outputFormat, `${field}.outputFormat`),
    useCurrentConfig: readOptionalBoolean(raw.useCurrentConfig, `${field}.useCurrentConfig`),
    projectConfigDirs: readOptionalStringArray(raw.projectConfigDirs, `${field}.projectConfigDirs`),
    userConfigDirs: readOptionalStringArray(raw.userConfigDirs, `${field}.userConfigDirs`),
    config: readOptionalRecord(raw.config, `${field}.config`),
    parser: readOptionalString(raw.parser, `${field}.parser`),
  };
}

function readTests(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('tests must be an array of project-relative glob strings');
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`tests[${index}] must be a project-relative glob string`);
    const trimmed = entry.trim();
    if (!trimmed) throw new Error(`tests[${index}] must not be empty`);
    validateProjectRelativeGlob(trimmed, `tests[${index}]`);
    return trimmed;
  });
}

function readAdapters(value: unknown): Record<string, AdapterDeclaration> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('adapters must be an object');

  const adapters: Record<string, AdapterDeclaration> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) throw new Error(`adapters.${name} must be an object`);
    assertKnownKeys(raw, ['module', 'export'], `adapters.${name}`);
    const module = readOptionalString(raw.module, `adapters.${name}.module`);
    if (!module) throw new Error(`adapters.${name}.module is required`);
    adapters[name] = { module, export: readOptionalString(raw.export, `adapters.${name}.export`) };
  }
  return adapters;
}

function readMockDefaults(value: unknown): Partial<MockConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('mocks must be an object');
  assertKnownKeys(value, ['root', 'strict', 'recordCalls'], 'mocks');
  return {
    root: readOptionalString(value.root, 'mocks.root'),
    strict: readOptionalBoolean(value.strict, 'mocks.strict'),
    recordCalls: readOptionalBoolean(value.recordCalls, 'mocks.recordCalls'),
  };
}

function readOutputConfig(value: unknown): Partial<OutputConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('output must be an object');
  assertKnownKeys(value, ['providers'], 'output');
  const providers = value.providers === undefined ? undefined : readOutputProviders(value.providers);
  return providers ? { providers } : undefined;
}

function readOutputProviders(value: unknown): OutputProviderConfig[] {
  if (!Array.isArray(value)) throw new Error('output.providers must be an array');
  return value.map((entry, index) => {
    const field = `output.providers[${index}]`;
    if (!isRecord(entry)) throw new Error(`${field} must be an object`);
    assertKnownKeys(entry, ['type', 'module', 'export', 'config'], field);
    const type = readOptionalString(entry.type, `${field}.type`);
    if (!type) throw new Error(`${field}.type is required`);
    const module = readOptionalString(entry.module, `${field}.module`);
    if (!BUILT_IN_PROVIDER_TYPES.has(type) && !module) throw new Error(`${field}.module is required for custom provider type ${type}`);
    return {
      type,
      module,
      export: readOptionalString(entry.export, `${field}.export`),
      config: readOptionalRecord(entry.config, `${field}.config`),
    };
  });
}

function readVisualizationConfig(value: unknown): HarnessConfigOverride['visualization'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('visualization must be an object');
  assertKnownKeys(value, ['enabled', 'formats', 'latest', 'include'], 'visualization');

  return {
    enabled: readOptionalBoolean(value.enabled, 'visualization.enabled'),
    formats: readOptionalVisualizationFormats(value.formats, 'visualization.formats'),
    latest: readOptionalBoolean(value.latest, 'visualization.latest'),
    include: readVisualizationInclude(value.include),
  };
}

function readVisualizationInclude(value: unknown): Partial<VisualizationConfig['include']> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('visualization.include must be an object');
  assertKnownKeys(value, ['logs', 'workspaceDiff', 'toolCalls', 'mockCalls', 'judgeDetails'], 'visualization.include');
  return {
    logs: readOptionalBoolean(value.logs, 'visualization.include.logs'),
    workspaceDiff: readOptionalBoolean(value.workspaceDiff, 'visualization.include.workspaceDiff'),
    toolCalls: readOptionalBoolean(value.toolCalls, 'visualization.include.toolCalls'),
    mockCalls: readOptionalBoolean(value.mockCalls, 'visualization.include.mockCalls'),
    judgeDetails: readOptionalBoolean(value.judgeDetails, 'visualization.include.judgeDetails'),
  };
}

function readOptionalVisualizationFormats(value: unknown, field: string): VisualizationFormat[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !VISUALIZATION_FORMATS.has(entry as VisualizationFormat)) {
      throw new Error(`${field}[${index}] must be one of: html, json, csv`);
    }
    return entry as VisualizationFormat;
  });
}

function readJudgeDefaults(value: unknown): JudgeDefaults | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('judge must be an object');
  assertKnownKeys(value, ['provider', 'model', 'apiKeyEnv', 'temperature', 'promptTemplate'], 'judge');
  const provider = readOptionalString(value.provider, 'judge.provider');
  const model = readOptionalString(value.model, 'judge.model');
  const apiKeyEnv = readOptionalString(value.apiKeyEnv, 'judge.apiKeyEnv');
  if (!provider) throw new Error('judge.provider is required');
  if (!model) throw new Error('judge.model is required');
  if (!apiKeyEnv) throw new Error('judge.apiKeyEnv is required');
  return {
    provider,
    model,
    apiKeyEnv,
    temperature: readOptionalNumber(value.temperature, 'judge.temperature'),
    promptTemplate: readOptionalString(value.promptTemplate, 'judge.promptTemplate'),
  };
}

function readScoringConfig(value: unknown): ProjectScoringConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('scoring must be an object');

  const scoring: ProjectScoringConfig = {};
  for (const [key, rawConfig] of Object.entries(value)) {
    if (!SCORING_TYPES.has(key as ScoreType)) throw new Error(`Unknown scoring key: ${key}`);
    const field = `scoring.${key}`;
    if (!isRecord(rawConfig)) throw new Error(`${field} must be an object`);
    const scoreType = key as ScoreType;
    const allowed = METRIC_SCORING_TYPES.has(scoreType) ? ['weight', 'target', 'best', 'worst'] : ['weight'];
    assertKnownKeys(rawConfig, allowed, field);
    const weight = readOptionalNumber(rawConfig.weight, `${field}.weight`);
    if (weight === undefined) throw new Error(`${field}.weight is required`);
    const target = readOptionalString(rawConfig.target, `${field}.target`);
    if (target && !SCORE_TARGETS.has(target)) throw new Error(`${field}.target must be maximize or minimize`);
    const scoreConfig: Record<string, unknown> = { weight };
    if (target) scoreConfig.target = target;
    const best = readOptionalNumber(rawConfig.best, `${field}.best`);
    if (best !== undefined) scoreConfig.best = best;
    const worst = readOptionalNumber(rawConfig.worst, `${field}.worst`);
    if (worst !== undefined) scoreConfig.worst = worst;
    scoring[scoreType] = scoreConfig as unknown as ProjectScoringConfig[typeof scoreType];
  }
  return scoring;
}

function readTestCase(value: unknown, path: string): TestCase {
  if (!isRecord(value)) throw new Error(`Test case must contain an object: ${path}`);
  const vars = isRecord(value.vars) ? value.vars : undefined;
  const id = readOptionalString(value.id, 'id') ?? readOptionalString(vars?.caseId, 'vars.caseId') ?? readOptionalString(value.description, 'description');
  if (!id) throw new Error(`Test case requires id: ${path}`);

  const timeoutMs = readOptionalNumber(value.timeoutMs, 'timeoutMs') ?? readOptionalNumber(vars?.timeout, 'vars.timeout');
  const topLevelArgs = readOptionalStringArray(value.args, 'args');
  const topLevelEnv = readOptionalStringArray(value.env, 'env');
  const topLevelConfig = readOptionalRecord(value.config, 'config') ?? readOptionalRecord(vars?.setup, 'vars.setup');
  const topLevelAssert = readAssertions(value.assert, 'assert');
  const steps = readSteps(value.steps, {
    path,
    fallbackPrompt: readOptionalString(value.prompt, 'prompt') ?? readOptionalString(vars?.prompt, 'vars.prompt'),
    fallbackTimeoutMs: timeoutMs,
    fallbackArgs: topLevelArgs,
    fallbackEnv: topLevelEnv,
    fallbackConfig: topLevelConfig,
    fallbackAssert: topLevelAssert,
  });
  validateUniqueArtifactStepIds(steps, path);
  const firstStep = steps[0];

  return {
    id,
    description: readOptionalString(value.description, 'description'),
    suite: readOptionalString(value.suite, 'suite'),
    agents: readAgentsSelection(value.agents),
    workspace: normalizeLegacyWorkspace(value.workspace, vars),
    mocks: readTestCaseMocks(value.mocks, 'mocks'),
    steps,
    timeoutMs,
    args: firstStep.args,
    env: firstStep.env,
    config: firstStep.config,
    parser: readOptionalString(value.parser, 'parser'),
    prompt: firstStep.prompt,
    assert: topLevelAssert.length > 0 ? topLevelAssert : firstStep.assert,
    sourcePath: path,
  };
}

function readSteps(value: unknown, options: {
  path: string;
  fallbackPrompt?: string;
  fallbackTimeoutMs?: number;
  fallbackArgs?: string[];
  fallbackEnv?: string[];
  fallbackConfig?: Record<string, unknown>;
  fallbackAssert: AssertionConfig[];
}): TestCaseStepDefinition[] {
  if (value === undefined || value === null) {
    if (!options.fallbackPrompt) throw new Error(`Test case requires prompt or steps: ${options.path}`);
    return [{
      id: 'run',
      prompt: options.fallbackPrompt,
      timeoutMs: options.fallbackTimeoutMs,
      args: options.fallbackArgs,
      env: options.fallbackEnv,
      config: options.fallbackConfig,
      assert: options.fallbackAssert,
    }];
  }

  if (!Array.isArray(value)) throw new Error('steps must be an array');
  if (value.length === 0) throw new Error('steps must not be empty');

  return value.map((entry, index) => {
    const field = `steps[${index}]`;
    if (!isRecord(entry)) throw new Error(`${field} must be an object`);
    assertKnownKeys(entry, ['id', 'prompt', 'timeoutMs', 'args', 'env', 'config', 'mocks', 'assert'], field);
    const id = readOptionalString(entry.id, `${field}.id`);
    if (!id) throw new Error(`${field}.id is required`);
    const prompt = readOptionalString(entry.prompt, `${field}.prompt`);
    if (!prompt) throw new Error(`${field}.prompt is required`);
    return {
      id,
      prompt,
      timeoutMs: readOptionalNumber(entry.timeoutMs, `${field}.timeoutMs`),
      args: readOptionalStringArray(entry.args, `${field}.args`),
      env: readOptionalStringArray(entry.env, `${field}.env`),
      config: readOptionalRecord(entry.config, `${field}.config`),
      mocks: readTestCaseMocks(entry.mocks, `${field}.mocks`),
      assert: readAssertions(entry.assert, `${field}.assert`),
    };
  });
}

function validateUniqueArtifactStepIds(steps: readonly TestCaseStepDefinition[], path: string): void {
  const seen = new Map<string, string>();
  for (const step of steps) {
    const artifactId = safeStepId(step.id);
    const existing = seen.get(artifactId);
    if (existing) throw new Error(`Step ids "${existing}" and "${step.id}" in ${path} both map to artifact id "${artifactId}"`);
    seen.set(artifactId, step.id);
  }
}

function readAgentsSelection(value: unknown): AgentsSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('agents must be an object');
  assertKnownKeys(value, ['include', 'exclude', 'overrides'], 'agents');
  return {
    include: readOptionalStringArray(value.include, 'agents.include'),
    exclude: readOptionalStringArray(value.exclude, 'agents.exclude'),
    overrides: readAgentOverrides(value.overrides),
  };
}

function readAgentOverrides(value: unknown): Record<string, Partial<AgentConfig>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('agents.overrides must be an object');
  return Object.fromEntries(Object.entries(value).map(([name, raw]) => {
    if (!isRecord(raw)) throw new Error(`agents.overrides.${name} must be an object`);
    return [name, { ...readAgentFields(raw, `agents.overrides.${name}`), adapter: readOptionalString(raw.adapter, `agents.overrides.${name}.adapter`) }];
  }));
}

function readTestCaseMocks(value: unknown, field: string): TestCaseMockConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['cli', 'mcp', 'strict'], field);
  return {
    cli: readStringRecord(value.cli, `${field}.cli`),
    mcp: readStringRecord(value.mcp, `${field}.mcp`),
    strict: readOptionalBoolean(value.strict, `${field}.strict`),
  };
}

function normalizeLegacyWorkspace(value: unknown, vars: Record<string, unknown> | undefined): Partial<TestCase['workspace']> | undefined {
  const workspace = readOptionalRecord(value, 'workspace') as Partial<TestCase['workspace']> | undefined;
  const fixture = readOptionalString(vars?.fixture, 'vars.fixture');
  if (!fixture) return workspace;
  return { ...(workspace ?? {}), fixture };
}

function normalizeTestCase(testCase: TestCase, projectRoot: string, path: string, mocks: MockConfig): TestCase {
  const fixture = testCase.workspace?.fixture
    ? resolveProjectPath(projectRoot, testCase.workspace.fixture, `workspace.fixture in ${path}`)
    : undefined;
  const source = testCase.workspace?.source
    ? resolveProjectPath(projectRoot, testCase.workspace.source, `workspace.source in ${path}`)
    : undefined;

  validateMockReferences(testCase.mocks, mocks.root, projectRoot, `mocks in ${path}`);
  for (const step of testCase.steps) {
    validateMockReferences(step.mocks, mocks.root, projectRoot, `steps.${step.id}.mocks in ${path}`);
  }

  return {
    ...testCase,
    workspace: testCase.workspace ? { ...testCase.workspace, source, fixture } : undefined,
  };
}

function readAssertions(value: unknown, field: string): AssertionConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${itemField} must be an object`);
    const type = readOptionalString(entry.type, `${itemField}.type`);
    if (!type) throw new Error(`${itemField}.type is required`);
    const allowedKeys = ASSERTION_KEYS[type];
    if (!allowedKeys) throw new Error(`Unknown assertion type: ${type}`);
    assertKnownKeys(entry, allowedKeys, itemField);
    const id = readOptionalString(entry.id, `${itemField}.id`);
    const required = readOptionalBoolean(entry.required, `${itemField}.required`) ?? true;
    if (type === 'llmJudge') {
      const threshold = readOptionalNumber(entry.threshold, `${itemField}.threshold`);
      if (threshold === undefined) throw new Error(`${itemField}.threshold is required`);
      if (threshold < 0 || threshold > 1) throw new Error(`${itemField}.threshold must be between 0 and 1`);
      return { ...entry, id, type, required, threshold, judge: readJudgeAssertion(entry.judge, `${itemField}.judge`) };
    }
    return { ...entry, id, type, required };
  });
}

function readJudgeAssertion(value: unknown, field: string): JudgeAssertionDefinition {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['provider', 'model', 'apiKeyEnv', 'temperature', 'promptTemplate', 'rubric', 'inputs'], field);
  const rubric = readOptionalString(value.rubric, `${field}.rubric`);
  if (!rubric) throw new Error(`${field}.rubric is required`);
  const inputs = readOptionalStringArray(value.inputs, `${field}.inputs`);
  if (!inputs || inputs.length === 0) throw new Error(`${field}.inputs is required`);
  for (const input of inputs) {
    if (!JUDGE_INPUT_REFS.has(input)) throw new Error(`${field}.inputs contains unsupported ref: ${input}`);
  }
  return {
    provider: readOptionalString(value.provider, `${field}.provider`),
    model: readOptionalString(value.model, `${field}.model`),
    apiKeyEnv: readOptionalString(value.apiKeyEnv, `${field}.apiKeyEnv`),
    temperature: readOptionalNumber(value.temperature, `${field}.temperature`),
    promptTemplate: readOptionalString(value.promptTemplate, `${field}.promptTemplate`),
    rubric,
    inputs: inputs as JudgeAssertionDefinition['inputs'],
  };
}

function validateJudgeAssertionDefaults(testCases: TestCase[], defaults: JudgeDefaults | undefined): void {
  for (const testCase of testCases) {
    for (const step of testCase.steps) {
      for (const assertion of step.assert) {
        if (assertion.type !== 'llmJudge') continue;
        const judgeAssertion = assertion as AssertionConfig & { judge: JudgeAssertionDefinition };
        const missing = [
          (judgeAssertion.judge.provider ?? defaults?.provider) ? undefined : 'provider',
          (judgeAssertion.judge.model ?? defaults?.model) ? undefined : 'model',
          (judgeAssertion.judge.apiKeyEnv ?? defaults?.apiKeyEnv) ? undefined : 'apiKeyEnv',
        ].filter((value): value is string => Boolean(value));
        if (missing.length > 0) {
          throw new Error(`llmJudge assertion ${judgeAssertion.id ?? judgeAssertion.type} in ${testCase.id}.${step.id} requires judge.${missing.join(', ')} or top-level judge defaults`);
        }
      }
    }
  }
}

function validateAdapters(adapters: Record<string, AdapterDeclaration>, projectRoot: string): void {
  for (const [name, declaration] of Object.entries(adapters)) {
    validateModuleSpecifier(declaration.module, projectRoot, `adapters.${name}.module`);
  }
}

function validateOutputProviders(providers: OutputProviderConfig[], projectRoot: string): void {
  for (const [index, provider] of providers.entries()) {
    if (provider.module) validateModuleSpecifier(provider.module, projectRoot, `output.providers[${index}].module`);
  }
}

function validateModuleSpecifier(module: string, projectRoot: string, field: string): void {
  if (module.startsWith('.') || module.startsWith('/')) {
    resolveProjectPath(projectRoot, module, field);
  }
}

function validateMockReferences(mocks: TestCaseMockConfig | undefined, mocksRoot: string, projectRoot: string, field: string): void {
  if (!mocks) return;
  for (const [surface, refs] of [['cli', mocks.cli], ['mcp', mocks.mcp]] as const) {
    if (!refs) continue;
    for (const [name, fixture] of Object.entries(refs)) {
      resolveMockFixturePath(mocksRoot, projectRoot, surface, fixture, `${field}.${surface}.${name}`);
    }
  }
}

function resolveMockFixturePath(mocksRoot: string, projectRoot: string, surface: 'cli' | 'mcp', fixture: string, field: string): string {
  if (hasTraversalSegment(fixture)) throw new Error(`Path escapes project root (${field}: ${fixture})`);
  const path = isFixtureName(fixture) ? join(mocksRoot, surface, withYamlExtension(fixture)) : withYamlExtension(fixture);
  return resolveProjectPath(projectRoot, path, field);
}

function withYamlExtension(path: string): string {
  return extname(path) ? path : `${path}.yaml`;
}

function isFixtureName(value: string): boolean {
  return !value.startsWith('.') && !value.includes('/') && !value.includes('\\');
}

function validateProjectRelativeGlob(pattern: string, field: string): void {
  if (isAbsolute(pattern) || pattern.startsWith('~')) throw new Error(`${field} must be project-relative`);
  if (hasTraversalSegment(pattern)) throw new Error(`Test file glob may not contain path traversal: ${pattern}`);
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

function readStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (typeof child !== 'string' || !child.trim()) throw new Error(`${field}.${key} must be a string`);
    return [key, child.trim()];
  }));
}

function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?}/g, (_match, name: string, fallback: string | undefined) => {
      return process.env[name] ?? fallback ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, interpolateEnv(child)]));
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${field}[${index}] must be a string`);
    return entry;
  });
}

function readOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${field} must be a number`);
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function readOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const STARTER_CONFIG = `
version: 1

artifactRoot: .harness-evals/runs
outputRoot: .harness-evals/output

workspace:
  source: .
  mode: copy
  containerPath: /workspace
  ignore:
    - .git
    - node_modules
    - .harness-evals

docker:
  repoPath: /workspace

agents:
  local-command:
    adapter: command
    command: echo
    args:
      - "{{ prompt }}"

output:
  providers:
    - type: file

visualization:
  enabled: true
  formats: [html, json, csv]
  latest: true
  include:
    logs: true
    workspaceDiff: true
    toolCalls: true
    mockCalls: true
    judgeDetails: true

scoring:
  assertionPassRate:
    weight: 1
  judgeScore:
    weight: 1
  latency:
    weight: 0
  cost:
    weight: 0
  tokenUsage:
    weight: 0

tests:
  - evals/tests/**/*.yaml
`;

const STARTER_TEST_CASE = `
id: starter-smoke
description: Starter validation that exercises the harness without requiring agent credentials.
suite: smoke
agents:
  include: [local-command]
prompt: Reply with HARNESS_EVALS_OK and do not edit files.
assert:
  - type: contains
    value: HARNESS_EVALS_OK
  - type: workspaceDiff
    changedFiles: []
`;
