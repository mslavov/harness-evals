import { afterEach, expect, test } from 'bun:test';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';
import { prepareCurrentAuth } from '../src/adapters/current-auth.js';
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
  'PI_CODING_AGENT_DIR',
  'PI_CAPTURE_PATH',
];

afterEach(async () => {
  restoreEnv();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('claude copies current config and sets CLAUDE_CONFIG_DIR when no auth env exists', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.claude');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'settings.json'), '{"theme":"dark"}');

  const input = prepareInput(root, { adapter: 'claude-code', userConfigDirs: [configDir] });
  const plan = await claudeCodeAdapter.prepareStep(input);

  const copiedDir = join(input.configDir, 'claude');
  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toEqual({ CLAUDE_CONFIG_DIR: '/agent-config/claude' });
  expect(plan.envNames).not.toContain('CLAUDE_CONFIG_DIR');
  expect(plan.cleanupPaths).toEqual([copiedDir]);
  expect(await readFile(join(copiedDir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
  expect(plan.metadata).toMatchObject({
    currentAuth: {
      sourcePath: configDir,
      targetPath: '/agent-config/claude',
      sourceExists: true,
      copied: true,
      envCredentialAvailable: false,
    },
  });
});

test('claude copies config even when an auth env exists and still forwards the credential', async () => {
  clearAuthEnv();
  setEnv('ANTHROPIC_AUTH_TOKEN', 'claude-token');
  const root = await tempRoot();
  const configDir = join(root, '.claude');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'settings.json'), '{"theme":"dark"}');

  const input = prepareInput(root, { adapter: 'claude-code', userConfigDirs: [configDir] });
  const plan = await claudeCodeAdapter.prepareStep(input);

  const copiedDir = join(input.configDir, 'claude');
  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toEqual({ CLAUDE_CONFIG_DIR: '/agent-config/claude' });
  expect(plan.envNames).toContain('ANTHROPIC_AUTH_TOKEN');
  expect(plan.cleanupPaths).toEqual([copiedDir]);
  expect(await readFile(join(copiedDir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
  expect(plan.metadata).toMatchObject({
    currentAuth: { copied: true, envCredentialAvailable: true },
  });
});

test('claude chmods .credentials.json to 0600 in the copied config dir', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.claude');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, '.credentials.json'), '{"token":"secret"}');

  const input = prepareInput(root, { adapter: 'claude-code', userConfigDirs: [configDir] });
  await claudeCodeAdapter.prepareStep(input);

  const credStat = await stat(join(input.configDir, 'claude', '.credentials.json'));
  expect(credStat.mode & 0o777).toBe(0o600);
});

test('current-auth copies sibling files (e.g. ~/.claude.json) into the copied config dir', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.claude');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'settings.json'), '{}');
  const siblingSource = join(root, 'claude-sibling.json');
  await writeFile(siblingSource, '{"mcpServers":{}}');

  const input = prepareInput(root, { adapter: 'claude-code', userConfigDirs: [configDir] });
  const plan = await prepareCurrentAuth(input, {
    adapterConfigName: 'claude',
    configEnvName: 'CLAUDE_CONFIG_DIR',
    defaultConfigDirs: [configDir],
    credentialEnvNames: ['ANTHROPIC_API_KEY'],
    siblingFiles: [{ sourcePath: siblingSource, targetName: '.claude.json' }],
  });

  const copiedDir = join(input.configDir, 'claude');
  expect(await readFile(join(copiedDir, '.claude.json'), 'utf8')).toBe('{"mcpServers":{}}');
  expect(plan.metadata.copiedSiblings).toEqual(['.claude.json']);
});

test('codex copies config and sets CODEX_HOME even when OPENAI_API_KEY exists', async () => {
  clearAuthEnv();
  setEnv('OPENAI_API_KEY', 'openai-key');
  const root = await tempRoot();
  const configDir = join(root, '.codex');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'auth.json'), '{"token":"secret"}');
  await writeFile(join(configDir, 'config.toml'), 'model = "o3"');

  const input = prepareInput(root, { adapter: 'codex', userConfigDirs: [configDir] });
  const plan = await codexAdapter.prepareStep(input);

  const copiedDir = join(input.configDir, 'codex');
  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toEqual({ CODEX_HOME: '/agent-config/codex' });
  expect(plan.envNames).toContain('OPENAI_API_KEY');
  expect(plan.cleanupPaths).toEqual([copiedDir]);
  expect(await readFile(join(copiedDir, 'config.toml'), 'utf8')).toBe('model = "o3"');
  const authStat = await stat(join(copiedDir, 'auth.json'));
  expect(authStat.mode & 0o777).toBe(0o600);
  expect(plan.metadata).toMatchObject({ currentAuth: { copied: true, envCredentialAvailable: true } });
});

test('codex exec injects a writable sandbox and skips the git-repo check by default', async () => {
  clearAuthEnv();
  const root = await tempRoot();

  const plan = await codexAdapter.prepareStep(prepareInput(root, {
    adapter: 'codex',
    userConfigDirs: [join(root, 'missing-codex')],
    useCurrentConfig: false,
    config: { useCurrentConfig: false },
  }));

  expect(plan.argv).toContain('--sandbox');
  expect(plan.argv[plan.argv.indexOf('--sandbox') + 1]).toBe('danger-full-access');
  expect(plan.argv).toContain('--skip-git-repo-check');
});

test('codex exec respects a user-supplied sandbox flag', async () => {
  clearAuthEnv();
  const root = await tempRoot();

  const plan = await codexAdapter.prepareStep(prepareInput(root, {
    adapter: 'codex',
    userConfigDirs: [join(root, 'missing-codex')],
    useCurrentConfig: false,
    config: { useCurrentConfig: false },
    args: ['--sandbox', 'workspace-write'],
  }));

  expect(plan.argv.filter((arg) => arg === '--sandbox')).toHaveLength(1);
  expect(plan.argv[plan.argv.indexOf('--sandbox') + 1]).toBe('workspace-write');
});

test('cursor copies current config and sets CURSOR_CONFIG_DIR when no CURSOR_API_KEY exists', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.cursor');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'cli-config.json'), '{}');

  const input = prepareInput(root, { adapter: 'cursor', userConfigDirs: [configDir] });
  const plan = await cursorAdapter.prepareStep(input);

  const copiedDir = join(input.configDir, 'cursor');
  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toEqual({ CURSOR_CONFIG_DIR: '/agent-config/cursor' });
  expect(plan.cleanupPaths).toEqual([copiedDir]);
  expect(plan.metadata).toMatchObject({ currentAuth: { sourceExists: true, copied: true } });
});

test('excludeDirs are skipped and configIncludeDirs force-keeps a default exclude', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.codex');
  await mkdir(join(configDir, 'sessions'), { recursive: true });
  await mkdir(join(configDir, 'prompts'), { recursive: true });
  await writeFile(join(configDir, 'sessions', 'a.jsonl'), 'x');
  await writeFile(join(configDir, 'prompts', 'p.md'), 'y');

  const input = prepareInput(root, {
    adapter: 'codex',
    userConfigDirs: [configDir],
    config: { configExcludeDirs: ['prompts'] },
  });
  const plan = await codexAdapter.prepareStep(input);

  const copiedDir = join(input.configDir, 'codex');
  expect(await pathExists(join(copiedDir, 'sessions'))).toBe(false);
  expect(await pathExists(join(copiedDir, 'prompts'))).toBe(false);
  expect(plan.metadata).toMatchObject({ currentAuth: { excludedDirs: expect.arrayContaining(['sessions', 'prompts']) } });

  const input2 = prepareInput(root, {
    adapter: 'codex',
    userConfigDirs: [configDir],
    config: { configIncludeDirs: ['sessions'] },
  });
  const plan2 = await codexAdapter.prepareStep(input2);
  const copiedDir2 = join(input2.configDir, 'codex');
  expect(await pathExists(join(copiedDir2, 'sessions'))).toBe(true);
});

test('symlink pointing outside the config dir is skipped with a warning', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.codex');
  await mkdir(configDir, { recursive: true });
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, join(configDir, 'link.txt'));

  const input = prepareInput(root, { adapter: 'codex', userConfigDirs: [configDir] });
  const plan = await codexAdapter.prepareStep(input);

  const copiedDir = join(input.configDir, 'codex');
  expect(await pathExists(join(copiedDir, 'link.txt'))).toBe(false);
  expect((plan.metadata as { currentAuth: { warnings: string[] } }).currentAuth.warnings.join('\n')).toContain('symlink');
});

test('missing source dir copies nothing but still forwards credentials', async () => {
  clearAuthEnv();
  setEnv('OPENAI_API_KEY', 'openai-key');
  const root = await tempRoot();

  const input = prepareInput(root, { adapter: 'codex', userConfigDirs: [join(root, 'missing-codex')] });
  const plan = await codexAdapter.prepareStep(input);

  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toBeUndefined();
  expect(plan.cleanupPaths).toBeUndefined();
  expect(plan.envNames).toContain('OPENAI_API_KEY');
  expect(plan.metadata).toMatchObject({ currentAuth: { sourceExists: false, copied: false } });
});

test('useCurrentConfig false disables the config copy', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const configDir = join(root, '.codex');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.toml'), 'model = "o3"');

  const input = prepareInput(root, {
    adapter: 'codex',
    userConfigDirs: [configDir],
    useCurrentConfig: true,
    config: { useCurrentConfig: false },
  });
  const plan = await codexAdapter.prepareStep(input);

  expect(plan.configMounts).toEqual([]);
  expect(plan.envValues).toBeUndefined();
  expect(plan.cleanupPaths).toBeUndefined();
  expect(await pathExists(join(input.configDir, 'codex'))).toBe(false);
  expect(plan.metadata).toMatchObject({
    currentAuth: {
      sourcePath: configDir,
      sourceExists: true,
      useCurrentConfig: false,
      copied: false,
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

test('pi complete uses pi print mode and current pi credentials', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const binDir = join(root, 'bin');
  const agentDir = join(root, 'pi-agent');
  const capturePath = join(root, 'pi-complete.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(binDir, 'pi'), FAKE_PI_COMPLETE);
  await chmod(join(binDir, 'pi'), 0o755);
  setEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
  setEnv('PI_CAPTURE_PATH', capturePath);

  const output = await piAdapter.complete!({
    projectRoot: root,
    agentName: 'pi-judge',
    agent: { adapter: 'pi', userConfigDirs: [agentDir] },
    input: 'Judge this output.',
  });
  const capture = JSON.parse(await readFile(capturePath, 'utf8')) as { args: string[]; cwd: string; piDir?: string };

  expect(output).toBe('{"score":0.9,"pass":true,"reason":"ok"}');
  expect(capture.cwd).toBe(await realpath(root));
  expect(capture.piDir).toBe(agentDir);
  expect(capture.args).toContain('-p');
  expect(capture.args).toContain('--no-tools');
  expect(capture.args).toContain('--no-session');
  expect(capture.args).toContain('--no-context-files');
  expect(capture.args).toContain('--system-prompt');
  expect(capture.args).toContain('You are a strict evaluation judge. Return only valid JSON.');
  expect(capture.args).not.toContain('--api-key');
  expect(capture.args).not.toContain('--provider');
  expect(capture.args).not.toContain('--model');
  expect(capture.args.at(-1)).toBe('Judge this output.');
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

test('pi stages out-of-repo local resources into the run config dir and rewrites their paths', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const extRoot = await tempRoot();
  const skillDir = join(extRoot, 'my-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '# skill');

  const agentDir = join(root, 'pi-agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ skills: [skillDir] }));

  const input = prepareInput(root, {
    adapter: 'pi',
    userConfigDirs: [agentDir],
    useCurrentConfig: true,
    config: { useCurrentConfig: true, copyCurrentConfigFiles: false },
  });
  const plan = await piAdapter.prepareStep(input);

  const generated = JSON.parse(await readFile(join(input.configDir, 'settings.json'), 'utf8')) as { skills: string[] };
  expect(generated.skills).toHaveLength(1);
  expect(generated.skills[0]).toMatch(/^\/agent-config\/pi-resources\/my-skill-[0-9a-f]{8}$/);

  const stagedName = generated.skills[0].split('/').at(-1)!;
  expect(await readFile(join(input.configDir, 'pi-resources', stagedName, 'SKILL.md'), 'utf8')).toBe('# skill');
  expect(plan.cleanupPaths).toContain(join(input.configDir, 'pi-resources'));
});

test('pi rewrites in-repo local resources to the container repo path without staging', async () => {
  clearAuthEnv();
  const root = await tempRoot();
  const skillDir = join(root, 'skills', 'local');
  await mkdir(skillDir, { recursive: true });

  const agentDir = join(root, 'pi-agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ skills: ['../skills/local'] }));

  const input = prepareInput(root, {
    adapter: 'pi',
    userConfigDirs: [agentDir],
    useCurrentConfig: true,
    config: { useCurrentConfig: true, copyCurrentConfigFiles: false },
  });
  const plan = await piAdapter.prepareStep(input);

  const generated = JSON.parse(await readFile(join(input.configDir, 'settings.json'), 'utf8')) as { skills: string[] };
  expect(generated.skills[0]).toBe('/workspace/skills/local');
  expect(plan.cleanupPaths ?? []).not.toContain(join(input.configDir, 'pi-resources'));
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

const FAKE_PI_COMPLETE = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');

writeFileSync(process.env.PI_CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  piDir: process.env.PI_CODING_AGENT_DIR,
}));
process.stdout.write('{"score":0.9,"pass":true,"reason":"ok"}\\n');
`;

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
