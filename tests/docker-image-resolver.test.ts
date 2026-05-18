import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { type AgentAdapter } from '../src/adapters/types.js';
import type { DockerConfig } from '../src/config/schema.js';
import { resolveDockerImage } from '../src/docker/image-resolver.js';

const tempDirs: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('ready image mode runs adapter probes, fails actionably, and never builds', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: [createProbeAdapter('probe-fail')] });

  await expect(resolveDockerImage({
    projectRoot: root,
    docker: dockerConfig('ready-image'),
    selectedAgents: [{ agentName: 'agent', agent: { adapter: 'probe' } }],
    adapterRegistry: registry,
  })).rejects.toThrow('Ready Docker image ready-image failed probe');

  const commands = await readDockerLog(root);
  expect(commands.filter((args) => args[0] === 'build')).toHaveLength(0);
  expect(commands.some((args) => args[0] === 'run' && args.includes('ready-image') && args.includes('probe-fail'))).toBe(true);
});

test('managed image mode builds once per manifest key and reuses a passing cached image', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: [createProbeAdapter('probe-ok')] });
  const input = {
    projectRoot: root,
    docker: dockerConfig(),
    selectedAgents: [{ agentName: 'agent', agent: { adapter: 'probe' } }],
    adapterRegistry: registry,
  };

  const first = await resolveDockerImage(input);
  const second = await resolveDockerImage(input);

  expect(first.mode).toBe('managed');
  expect(first.cacheHit).toBe(false);
  expect(second.cacheHit).toBe(true);
  expect(second.cacheKey).toBe(first.cacheKey);
  expect(second.image).toBe(first.image);
  const commands = await readDockerLog(root);
  expect(commands.filter((args) => args[0] === 'build')).toHaveLength(1);
  expect(commands.filter((args) => args[0] === 'run' && args.includes('probe-ok'))).toHaveLength(2);
});

test('refreshing an existing managed image rebuilds with pull and no cache', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: [createProbeAdapter('probe-ok')] });
  const input = {
    projectRoot: root,
    docker: dockerConfig(),
    selectedAgents: [{ agentName: 'agent', agent: { adapter: 'probe' } }],
    adapterRegistry: registry,
  };

  const first = await resolveDockerImage(input);
  const refreshed = await resolveDockerImage({ ...input, refreshManagedImage: true });

  expect(refreshed.mode).toBe('managed');
  expect(refreshed.cacheHit).toBe(false);
  expect(refreshed.cacheKey).toBe(first.cacheKey);
  expect(refreshed.image).toBe(first.image);
  const builds = (await readDockerLog(root)).filter((args) => args[0] === 'build');
  expect(builds).toHaveLength(2);
  expect(builds[1]).toContain('--pull');
  expect(builds[1]).toContain('--no-cache');
});

test('refresh skips the cached managed image probe before rebuild', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: [createProbeAdapter('probe-ok')] });
  const input = {
    projectRoot: root,
    docker: dockerConfig(),
    selectedAgents: [{ agentName: 'agent', agent: { adapter: 'probe' } }],
    adapterRegistry: registry,
  };

  await resolveDockerImage(input);
  await resolveDockerImage({ ...input, refreshManagedImage: true });

  const commands = await readDockerLog(root);
  expect(commands.filter((args) => args[0] === 'image' && args[1] === 'inspect')).toHaveLength(1);
  expect(commands.filter((args) => args[0] === 'run' && args.includes('probe-ok'))).toHaveLength(2);
});

test('ready image with refresh remains probe-only and never builds', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: [createProbeAdapter('probe-ok')] });

  const result = await resolveDockerImage({
    projectRoot: root,
    docker: dockerConfig('ready-image'),
    selectedAgents: [{ agentName: 'agent', agent: { adapter: 'probe' } }],
    adapterRegistry: registry,
    refreshManagedImage: true,
  });

  expect(result.mode).toBe('ready');
  expect(result.image).toBe('ready-image');
  const commands = await readDockerLog(root);
  expect(commands.filter((args) => args[0] === 'build')).toHaveLength(0);
  expect(commands.filter((args) => args[0] === 'image' && args[1] === 'inspect')).toHaveLength(0);
  expect(commands.filter((args) => args[0] === 'run' && args.includes('ready-image') && args.includes('probe-ok'))).toHaveLength(1);
});

test('concurrent refresh calls for the same managed manifest dedupe to one build', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: [createProbeAdapter('probe-ok')] });
  const input = {
    projectRoot: root,
    docker: dockerConfig(),
    selectedAgents: [{ agentName: 'agent', agent: { adapter: 'probe' } }],
    adapterRegistry: registry,
    refreshManagedImage: true,
  };

  const [first, second] = await Promise.all([resolveDockerImage(input), resolveDockerImage(input)]);

  expect(first.cacheHit).toBe(false);
  expect(second.cacheHit).toBe(false);
  expect(second.cacheKey).toBe(first.cacheKey);
  expect(second.image).toBe(first.image);
  const builds = (await readDockerLog(root)).filter((args) => args[0] === 'build');
  expect(builds).toHaveLength(1);
  expect(builds[0]).toContain('--pull');
  expect(builds[0]).toContain('--no-cache');
});

test('managed image cache hit probe failure triggers one rebuild for the same key', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: [createProbeAdapter('probe-flaky')] });
  const input = {
    projectRoot: root,
    docker: dockerConfig(),
    selectedAgents: [{ agentName: 'agent', agent: { adapter: 'probe' } }],
    adapterRegistry: registry,
  };

  const first = await resolveDockerImage(input);
  const state = await readState(root);
  await writeState(root, { ...state, flakyFailures: 1 });
  const second = await resolveDockerImage(input);

  expect(second.cacheKey).toBe(first.cacheKey);
  expect(second.image).toBe(first.image);
  expect(second.cacheHit).toBe(false);
  expect(second.probes.every((probe) => probe.pass)).toBe(true);
  const commands = await readDockerLog(root);
  expect(commands.filter((args) => args[0] === 'build')).toHaveLength(2);
  expect(commands.filter((args) => args[0] === 'run' && args.includes('probe-flaky'))).toHaveLength(3);
});

function createProbeAdapter(probeCommand: string): AgentAdapter {
  return {
    name: 'probe',
    getInstallRecipe() {
      return Promise.resolve({
        commands: ['echo installing probe'],
        probes: [{ command: [probeCommand] }],
        cacheKey: `probe:${probeCommand}`,
      });
    },
    async prepareStep() {
      return { argv: ['probe'], cwd: '/workspace', envNames: [], configMounts: [], parser: 'text' };
    },
    async parseEvents() {
      return { finalOutput: '', toolCalls: [], errors: [] };
    },
  };
}

function dockerConfig(image?: string): DockerConfig {
  return {
    image,
    repoPath: '/workspace',
    home: '/home/harness',
    configRoot: '/agent-config',
    timeoutMs: 1000,
    envAllowlist: [],
  };
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-'));
  tempDirs.push(path);
  return path;
}

async function installFakeDocker(root: string): Promise<() => void> {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'docker'), FAKE_DOCKER);
  await chmod(join(binDir, 'docker'), 0o755);

  const previousPath = process.env.PATH;
  const previousRoot = process.env.FAKE_DOCKER_ROOT;
  process.env.PATH = previousPath ? `${binDir}:${previousPath}` : binDir;
  process.env.FAKE_DOCKER_ROOT = root;
  return () => {
    process.env.PATH = previousPath;
    if (previousRoot === undefined) delete process.env.FAKE_DOCKER_ROOT;
    else process.env.FAKE_DOCKER_ROOT = previousRoot;
  };
}

async function readDockerLog(root: string): Promise<string[][]> {
  const content = await readFile(join(root, 'fake-docker.log'), 'utf8');
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

async function readState(root: string): Promise<FakeDockerState> {
  try {
    return JSON.parse(await readFile(join(root, 'fake-docker-state.json'), 'utf8')) as FakeDockerState;
  } catch {
    return { images: [], flakyFailures: 0 };
  }
}

async function writeState(root: string, state: FakeDockerState): Promise<void> {
  await writeFile(join(root, 'fake-docker-state.json'), JSON.stringify(state));
}

interface FakeDockerState {
  images: string[];
  flakyFailures: number;
}

const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = process.env.FAKE_DOCKER_ROOT;
if (!root) {
  console.error('FAKE_DOCKER_ROOT is required');
  process.exit(1);
}

const args = process.argv.slice(2);
appendFileSync(join(root, 'fake-docker.log'), JSON.stringify(args) + '\\n');

const statePath = join(root, 'fake-docker-state.json');
const state = readState();

if (args[0] === 'rm') process.exit(0);

if (args[0] === 'image' && args[1] === 'inspect') {
  process.exit(state.images.includes(args[2]) ? 0 : 1);
}

if (args[0] === 'build') {
  const tag = args[args.indexOf('-t') + 1];
  if (!state.images.includes(tag)) state.images.push(tag);
  writeState(state);
  process.exit(0);
}

if (args[0] === 'run') {
  let index = 1;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--rm') {
      index += 1;
      continue;
    }
    if (arg === '--name') {
      index += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }

  const image = args[index];
  const command = args[index + 1];
  if (!image) process.exit(1);
  if (command === 'probe-fail') {
    console.error('probe failed');
    process.exit(42);
  }
  if (command === 'probe-flaky' && state.flakyFailures > 0) {
    state.flakyFailures -= 1;
    writeState(state);
    console.error('flaky probe failed');
    process.exit(42);
  }
  writeState(state);
  console.log(command + ' ok');
  process.exit(0);
}

console.error('Unsupported fake docker args: ' + args.join(' '));
process.exit(1);

function readState() {
  if (!existsSync(statePath)) return { images: [], flakyFailures: 0 };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writeState(next) {
  writeFileSync(statePath, JSON.stringify(next));
}
`;
