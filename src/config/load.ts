import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import YAML from 'yaml';
import { resolveAgentExtends, withHarnessDefaults, type HarnessConfigOverride } from './merge.js';
import { findHarnessConfig, resolveOptionalProjectPath, resolveProjectPath } from './paths.js';
import type { AgentConfig, AssertionConfig, HarnessConfig, LoadedHarnessConfig, TestCase, TestReference } from './schema.js';

export interface LoadHarnessConfigOptions {
  cwd?: string;
  configPath?: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const builtinCasesRoot = join(packageRoot, 'cases');

export async function loadHarnessConfig(options: LoadHarnessConfigOptions = {}): Promise<LoadedHarnessConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath ? resolve(cwd, options.configPath) : await findHarnessConfig(cwd);
  const projectRoot = dirname(configPath);
  const rawConfig = await readYamlFile(configPath);
  const interpolated = interpolateEnv(rawConfig);
  const config = normalizeHarnessConfig(withHarnessDefaults(readHarnessConfig(interpolated)), projectRoot, configPath);
  const testCases = await loadTestCases(config.tests, projectRoot);

  return {
    ...config,
    projectRoot,
    configPath,
    testCases,
  };
}

export async function writeStarterConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${STARTER_CONFIG.trim()}\n`);
}

async function loadTestCases(refs: TestReference[], projectRoot: string): Promise<TestCase[]> {
  const cases: TestCase[] = [];

  for (const ref of refs) {
    if (ref.builtin) {
      const casePath = resolveProjectPath(builtinCasesRoot, `${ref.builtin}.yaml`, `tests.builtin ${ref.builtin}`);
      cases.push(await loadTestCaseFile(casePath, projectRoot, ref.suite));
      continue;
    }

    if (ref.file) {
      const pattern = ref.file.replace(/^file:\/\//, '');
      if (pattern.includes('..')) {
        throw new Error(`Test file glob may not contain path traversal: ${ref.file}`);
      }
      const matches = await fg(pattern, { cwd: projectRoot, absolute: true, onlyFiles: true });
      for (const match of matches.sort()) {
        resolveProjectPath(projectRoot, match, `tests.file ${ref.file}`);
        cases.push(await loadTestCaseFile(match, projectRoot, ref.suite));
      }
    }
  }

  return cases;
}

async function loadTestCaseFile(path: string, projectRoot: string, suite?: string): Promise<TestCase> {
  const raw = await readYamlFile(path);
  const parsed = readTestCase(interpolateEnv(raw), path, suite);
  return normalizeTestCase(parsed, projectRoot, path);
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
  };
}

function normalizeHarnessConfig(config: HarnessConfig, projectRoot: string, configPath: string): HarnessConfig {
  const workspaceSource = resolveProjectPath(projectRoot, config.workspace.source, 'workspace.source');

  return {
    ...config,
    artifactRoot: resolveProjectPath(projectRoot, config.artifactRoot, 'artifactRoot'),
    outputRoot: resolveProjectPath(projectRoot, config.outputRoot, 'outputRoot'),
    workspace: {
      ...config.workspace,
      source: workspaceSource,
      fixture: resolveOptionalProjectPath(projectRoot, config.workspace.fixture, 'workspace.fixture'),
    },
    docker: config.docker,
    agents: resolveAgentExtends(config.agents),
    tests: config.tests.length > 0 ? config.tests : [{ file: 'evals/cases/**/*.yaml' }],
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
    agents[name] = readAgentConfig(rawAgent, adapter ?? (parent ? undefined : 'command'));
  }
  return agents;
}

function readAgentConfig(raw: Record<string, unknown>, fallbackAdapter: string | undefined): AgentConfig {
  return {
    adapter: (readOptionalString(raw.adapter, 'agent.adapter') ?? fallbackAdapter) as string,
    extends: readOptionalString(raw.extends, 'agent.extends'),
    label: readOptionalString(raw.label, 'agent.label'),
    command: readOptionalString(raw.command, 'agent.command'),
    args: readOptionalStringArray(raw.args, 'agent.args'),
    cwd: readOptionalString(raw.cwd, 'agent.cwd'),
    env: readOptionalStringArray(raw.env, 'agent.env'),
    envAllowlist: readOptionalStringArray(raw.envAllowlist, 'agent.envAllowlist'),
    timeoutMs: readOptionalNumber(raw.timeoutMs, 'agent.timeoutMs'),
    provider: readOptionalString(raw.provider, 'agent.provider'),
    providerEnv: readOptionalString(raw.providerEnv, 'agent.providerEnv'),
    model: readOptionalString(raw.model, 'agent.model'),
    modelEnv: readOptionalString(raw.modelEnv, 'agent.modelEnv'),
    apiKeyEnv: readOptionalString(raw.apiKeyEnv, 'agent.apiKeyEnv'),
    profile: readOptionalString(raw.profile, 'agent.profile'),
    outputFormat: readOptionalString(raw.outputFormat, 'agent.outputFormat'),
    useCurrentConfig: readOptionalBoolean(raw.useCurrentConfig, 'agent.useCurrentConfig'),
    projectConfigDirs: readOptionalStringArray(raw.projectConfigDirs, 'agent.projectConfigDirs'),
    userConfigDirs: readOptionalStringArray(raw.userConfigDirs, 'agent.userConfigDirs'),
    config: readOptionalRecord(raw.config, 'agent.config'),
    parser: readOptionalString(raw.parser, 'agent.parser'),
  };
}

function readTests(value: unknown): TestReference[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('tests must be an array');
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`tests[${index}] must be an object`);
    const file = readOptionalString(entry.file, `tests[${index}].file`);
    const builtin = readOptionalString(entry.builtin, `tests[${index}].builtin`);
    if (!file && !builtin) throw new Error(`tests[${index}] requires file or builtin`);
    return { file, builtin, suite: readOptionalString(entry.suite, `tests[${index}].suite`) };
  });
}

function readTestCase(value: unknown, path: string, suite: string | undefined): TestCase {
  if (!isRecord(value)) throw new Error(`Test case must contain an object: ${path}`);
  const vars = isRecord(value.vars) ? value.vars : undefined;
  const id = readOptionalString(value.id, 'id') ?? readOptionalString(vars?.caseId, 'vars.caseId') ?? readOptionalString(value.description, 'description');
  if (!id) throw new Error(`Test case requires id: ${path}`);

  return {
    id,
    description: readOptionalString(value.description, 'description'),
    suite: readOptionalString(value.suite, 'suite') ?? suite,
    agents: readOptionalRecord(value.agents, 'agents') as TestCase['agents'],
    workspace: normalizeLegacyWorkspace(value.workspace, vars),
    prompt: readOptionalString(value.prompt, 'prompt') ?? readOptionalString(vars?.prompt, 'vars.prompt') ?? '',
    assert: readAssertions(value.assert),
    timeoutMs: readOptionalNumber(value.timeoutMs, 'timeoutMs') ?? readOptionalNumber(vars?.timeout, 'vars.timeout'),
    args: readOptionalStringArray(value.args, 'args'),
    env: readOptionalStringArray(value.env, 'env'),
    config: readOptionalRecord(value.config, 'config') ?? readOptionalRecord(vars?.setup, 'vars.setup'),
    parser: readOptionalString(value.parser, 'parser'),
    sourcePath: path,
  };
}

function normalizeLegacyWorkspace(value: unknown, vars: Record<string, unknown> | undefined): Partial<TestCase['workspace']> | undefined {
  const workspace = readOptionalRecord(value, 'workspace') as Partial<TestCase['workspace']> | undefined;
  const fixture = readOptionalString(vars?.fixture, 'vars.fixture');
  if (!fixture) return workspace;
  return { ...(workspace ?? {}), fixture };
}

function normalizeTestCase(testCase: TestCase, projectRoot: string, path: string): TestCase {
  const fixture = testCase.workspace?.fixture
    ? resolveProjectPath(projectRoot, testCase.workspace.fixture, `workspace.fixture in ${path}`)
    : undefined;
  const source = testCase.workspace?.source
    ? resolveProjectPath(projectRoot, testCase.workspace.source, `workspace.source in ${path}`)
    : undefined;

  return {
    ...testCase,
    workspace: testCase.workspace ? { ...testCase.workspace, source, fixture } : undefined,
  };
}

function readAssertions(value: unknown): AssertionConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('assert must be an array');
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`assert[${index}] must be an object`);
    const type = readOptionalString(entry.type, `assert[${index}].type`);
    if (!type) throw new Error(`assert[${index}].type is required`);
    return { ...entry, type };
  });
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
    const parsed = Number.parseInt(value, 10);
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
  image: oven/bun:1.2.10
  repoPath: /workspace

agents:
  pi-gpt:
    adapter: pi
    useCurrentConfig: true
    projectConfigDirs:
      - .pi
    userConfigDirs:
      - ~/.pi/agent

tests:
  - file: evals/cases/**/*.yaml
  - builtin: agent-setup-smoke
`;
