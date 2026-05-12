import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { commandAdapter } from '../src/adapters/command.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { piAdapter } from '../src/adapters/pi.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { AgentAdapter, AgentStepPrepareInput } from '../src/adapters/types.js';
import { runHarness } from '../src/runner/evaluate.js';

const tempDirs: string[] = [];
const originalEnv = new Map<string, string | undefined>();

const AUTH_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CURSOR_API_KEY',
  'PI_EVAL_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CURSOR_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'CUSTOM_AGENT_KEY',
  'CUSTOM_ADAPTER_TOKEN',
];

afterEach(async () => {
  restoreEnv();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('claude mounts current config and sets CLAUDE_CONFIG_DIR when no auth env exists', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.claude');
  await mkdir(configDir, { recursive: true });

  const plan = await claudeCodeAdapter.prepareStep(prepareInput(root, {
    adapter: 'claude-code',
    userConfigDirs: [configDir],
  }));

  expect(plan.configMounts).toEqual([{ source: configDir, target: '/agent-config/claude', readonly: true }]);
  expect(plan.envValues).toEqual({ CLAUDE_CONFIG_DIR: '/agent-config/claude' });
  expect(plan.envNames).not.toContain('CLAUDE_CONFIG_DIR');
  expect(plan.metadata).toMatchObject({
    currentAuth: {
      sourcePath: configDir,
      targetPath: '/agent-config/claude',
      sourceExists: true,
      mounted: true,
      skippedBecauseEnvCredentialAvailable: false,
    },
  });
});

test('claude skips current-auth mount when an auth env exists', async () => {
  clearAuthEnv();
  setEnv('ANTHROPIC_AUTH_TOKEN', 'claude-token');
  const root = await tempRoot();
  const configDir = join(root, '.claude');
  await mkdir(configDir, { recursive: true });

  const plan = await claudeCodeAdapter.prepareStep(prepareInput(root, {
    adapter: 'claude-code',
    userConfigDirs: [configDir],
  }));

  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toBeUndefined();
  expect(plan.envNames).toContain('ANTHROPIC_AUTH_TOKEN');
  expect(plan.metadata).toMatchObject({
    currentAuth: {
      sourcePath: configDir,
      sourceExists: true,
      mounted: false,
      skippedBecauseEnvCredentialAvailable: true,
    },
  });
});

test('codex mounts current config and sets CODEX_HOME when no OPENAI_API_KEY exists', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.codex');
  await mkdir(configDir, { recursive: true });

  const plan = await codexAdapter.prepareStep(prepareInput(root, {
    adapter: 'codex',
    userConfigDirs: [configDir],
  }));

  expect(plan.configMounts).toEqual([{ source: configDir, target: '/agent-config/codex', readonly: true }]);
  expect(plan.envValues).toEqual({ CODEX_HOME: '/agent-config/codex' });
  expect(plan.metadata).toMatchObject({ currentAuth: { sourceExists: true, mounted: true } });
});

test('cursor mounts current config and sets CURSOR_CONFIG_DIR when no CURSOR_API_KEY exists', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.cursor');
  await mkdir(configDir, { recursive: true });

  const plan = await cursorAdapter.prepareStep(prepareInput(root, {
    adapter: 'cursor',
    userConfigDirs: [configDir],
  }));

  expect(plan.configMounts).toEqual([{ source: configDir, target: '/agent-config/cursor', readonly: true }]);
  expect(plan.envValues).toEqual({ CURSOR_CONFIG_DIR: '/agent-config/cursor' });
  expect(plan.metadata).toMatchObject({ currentAuth: { sourceExists: true, mounted: true } });
});

test('useCurrentConfig false disables current-auth fallback', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.codex');
  await mkdir(configDir, { recursive: true });

  const plan = await codexAdapter.prepareStep(prepareInput(root, {
    adapter: 'codex',
    userConfigDirs: [configDir],
    useCurrentConfig: true,
    config: { useCurrentConfig: false },
  }));

  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toBeUndefined();
  expect(plan.metadata).toMatchObject({
    currentAuth: {
      sourcePath: configDir,
      sourceExists: true,
      useCurrentConfig: false,
      mounted: false,
    },
  });
});

test('agent.apiKeyEnv is forwarded by built-in adapters that can use API keys', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const apiKeyEnv = 'CUSTOM_AGENT_KEY';
  const adapters: Array<{ adapter: AgentAdapter; agent: Partial<AgentConfig> & { adapter: string } }> = [
    { adapter: claudeCodeAdapter, agent: { adapter: 'claude-code' } },
    { adapter: codexAdapter, agent: { adapter: 'codex' } },
    { adapter: cursorAdapter, agent: { adapter: 'cursor' } },
    { adapter: commandAdapter, agent: { adapter: 'command', command: 'echo' } },
    { adapter: piAdapter, agent: { adapter: 'pi', userConfigDirs: [join(root, 'missing-pi')] } },
  ];

  for (const entry of adapters) {
    const plan = await entry.adapter.prepareStep(prepareInput(root, {
      ...entry.agent,
      apiKeyEnv,
      useCurrentConfig: false,
      config: { useCurrentConfig: false },
    }));
    expect(plan.envNames).toContain(apiKeyEnv);
  }
});

test('pi omits absent implicit PI_EVAL_API_KEY and --api-key without a key value', async () => {
  clearAuthEnv();
  const root = await tempRoot();

  const plan = await piAdapter.prepareStep(prepareInput(root, {
    adapter: 'pi',
    userConfigDirs: [join(root, 'missing-pi')],
    useCurrentConfig: false,
    config: { useCurrentConfig: false },
  }));

  expect(plan.envNames).not.toContain('PI_EVAL_API_KEY');
  expect(plan.argv).not.toContain('--api-key');
});

test('run redaction includes adapter-default auth envs', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const secret = 'adapter-default-secret';
  setEnv('CLAUDE_CODE_OAUTH_TOKEN', secret);
  await installFakeDocker(root);
  await mkdir(join(root, 'cases'), { recursive: true });
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
artifactRoot: runs
outputRoot: output
docker:
  image: fake-image
  timeoutMs: 1000
  envAllowlist: []
agents:
  claude:
    adapter: claude-code
    command: node
    useCurrentConfig: false
    config:
      useCurrentConfig: false
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: redact-adapter-auth
prompt: process.env.CLAUDE_CODE_OAUTH_TOKEN
assert: []
`);

  const result = await runHarness({ cwd: root });
  const runDir = result.results[0].runDir;
  const stdout = await readFile(join(runDir, 'steps', 'run', 'stdout.log'), 'utf8');
  const command = JSON.parse(await readFile(join(runDir, 'steps', 'run', 'command.redacted.json'), 'utf8')) as { env: Record<string, string> };
  const latest = await readFile(join(root, 'output', 'latest', 'results.json'), 'utf8');

  expect(result.pass).toBe(true);
  expect(stdout).toBe('<redacted:CLAUDE_CODE_OAUTH_TOKEN>\n');
  expect(command.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('<redacted:CLAUDE_CODE_OAUTH_TOKEN>');
  expect(JSON.stringify(command)).not.toContain(secret);
  expect(latest).not.toContain(secret);
});

test('run redaction uses auth env names exposed by project adapters', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const secret = 'custom-adapter-secret';
  setEnv('CUSTOM_ADAPTER_TOKEN', secret);
  await installFakeDocker(root);
  await mkdir(join(root, 'cases'), { recursive: true });
  await writeFile(join(root, 'custom-adapter.mjs'), `
export default {
  name: 'custom-auth',
  authEnvNames: ['CUSTOM_ADAPTER_TOKEN'],
  async prepareStep(input) {
    return {
      argv: ['node', '-e', 'console.log(process.env.CUSTOM_ADAPTER_TOKEN)'],
      cwd: input.workspace.containerPath,
      envNames: ['CUSTOM_ADAPTER_TOKEN'],
      configMounts: [],
      parser: 'text',
    };
  },
  async parseEvents(input) {
    return { finalOutput: input.stdout.trim(), toolCalls: [], errors: [] };
  },
};
`);
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
artifactRoot: runs
outputRoot: output
docker:
  image: fake-image
  timeoutMs: 1000
  envAllowlist: []
adapters:
  custom-auth:
    module: ./custom-adapter.mjs
agents:
  custom:
    adapter: custom-auth
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: redact-project-adapter-auth
prompt: ignored
assert: []
`);

  const result = await runHarness({ cwd: root });
  const runDir = result.results[0].runDir;
  const stdout = await readFile(join(runDir, 'steps', 'run', 'stdout.log'), 'utf8');
  const command = JSON.parse(await readFile(join(runDir, 'steps', 'run', 'command.redacted.json'), 'utf8')) as { env: Record<string, string> };
  const latest = await readFile(join(root, 'output', 'latest', 'results.json'), 'utf8');

  expect(result.pass).toBe(true);
  expect(stdout).toBe('<redacted:CUSTOM_ADAPTER_TOKEN>\n');
  expect(command.env.CUSTOM_ADAPTER_TOKEN).toBe('<redacted:CUSTOM_ADAPTER_TOKEN>');
  expect(JSON.stringify(command)).not.toContain(secret);
  expect(latest).not.toContain(secret);
});

function prepareInput(root: string, agent: Partial<AgentConfig> & { adapter: string }): AgentStepPrepareInput {
  return {
    projectRoot: root,
    agentName: 'agent',
    agent: { ...agent },
    testCase: {
      id: 'case',
      prompt: 'prompt',
      assert: [],
      steps: [{ id: 'run', prompt: 'prompt', assert: [] }],
    },
    step: { id: 'run', prompt: 'prompt', assert: [] },
    stepIndex: 0,
    prompt: 'prompt',
    runDir: join(root, 'run'),
    stepDir: join(root, 'run', 'steps', 'run'),
    workspaceDir: join(root, 'run', 'workspace'),
    configDir: join(root, 'run', 'config'),
    workspace: {
      source: root,
      mode: 'copy',
      containerPath: '/workspace',
      ignore: [],
    },
    docker: {
      image: 'fake-image',
      repoPath: '/workspace',
      home: '/home/harness',
      configRoot: '/agent-config',
      timeoutMs: 1000,
      envAllowlist: [],
    },
  };
}

async function installFakeDocker(root: string): Promise<void> {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'docker'), FAKE_DOCKER);
  await chmod(join(binDir, 'docker'), 0o755);
  setEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-'));
  tempDirs.push(path);
  return path;
}

function clearAuthEnv(): void {
  for (const name of AUTH_ENV_NAMES) setEnv(name, undefined);
}

function setEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const FAKE_DOCKER = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args[0] === 'rm') process.exit(0);
if (args[0] !== 'run') {
  console.error('Unsupported fake docker args: ' + args.join(' '));
  process.exit(1);
}

let index = 1;
let workdir;
const mounts = [];
const env = { PATH: process.env.PATH };
while (index < args.length) {
  const arg = args[index];
  if (arg === '--rm') {
    index += 1;
    continue;
  }
  if (arg === '--name' || arg === '--user') {
    index += 2;
    continue;
  }
  if (arg === '--workdir') {
    workdir = args[index + 1];
    index += 2;
    continue;
  }
  if (arg === '--mount') {
    mounts.push(parseMount(args[index + 1]));
    index += 2;
    continue;
  }
  if (arg === '-e') {
    const spec = args[index + 1];
    const equals = spec.indexOf('=');
    if (equals === -1) {
      if (process.env[spec] !== undefined) env[spec] = process.env[spec];
    } else {
      env[spec.slice(0, equals)] = spec.slice(equals + 1);
    }
    index += 2;
    continue;
  }
  if (arg.startsWith('-')) {
    index += 1;
    continue;
  }
  break;
}

index += 1;
const command = args[index];
const commandArgs = args.slice(index + 1);
if (!command) process.exit(0);
const result = spawnSync(command, commandArgs, {
  cwd: workdir ? mapPath(workdir) : process.cwd(),
  env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(result.error.message);
  process.exit(127);
}
process.exit(result.status ?? (result.signal ? 1 : 0));

function parseMount(value) {
  const mount = {};
  for (const part of value.split(',')) {
    const equals = part.indexOf('=');
    if (equals !== -1) mount[part.slice(0, equals)] = part.slice(equals + 1);
  }
  return mount;
}

function mapPath(path) {
  for (const mount of mounts) {
    if (path === mount.target || path.startsWith(mount.target + '/')) return mount.source + path.slice(mount.target.length);
  }
  return path;
}
`;
