import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHarnessConfig } from '../src/config/load.js';
import { buildMatrix } from '../src/runner/matrix.js';
import { builtInAdapters, createAdapterRegistry } from '../src/adapters/registry.js';
import { resolveDockerImage } from '../src/docker/image-resolver.js';
import { runVerifier } from '../src/verifier/run.js';
import type { DockerConfig, WorkspaceConfig } from '../src/config/schema.js';

const tempDirs: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('per-case image becomes docker.baseImage and verifier.assetsDir resolves to an absolute project path', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  cmd:
    adapter: command
    command: echo
tests:
  - cases/*.yaml
`);
  await mkdir(join(root, 'cases'));
  await writeFile(join(root, 'cases', 'task.yaml'), `
id: task-a
image: public.ecr.aws/example/task-a:latest
workspace:
  seedFromImage: true
  seedPath: /app
  containerPath: /app
prompt: do the task
assert: []
verifier:
  command: bash
  args: [/tests/run.sh]
  assetsDir: assets/task-a/tests
  rewardFile: .reward.txt
  rewardFormat: text
`);

  const config = await loadHarnessConfig({ cwd: root });
  const matrix = buildMatrix(config);

  expect(matrix).toHaveLength(1);
  const [entry] = matrix;
  expect(entry.docker.baseImage).toBe('public.ecr.aws/example/task-a:latest');
  expect(entry.docker.image).toBeUndefined();
  expect(entry.workspace.seedFromImage).toBe(true);
  expect(entry.workspace.containerPath).toBe('/app');
  expect(entry.testCase.verifier?.assetsDir).toBe(join(root, 'assets/task-a/tests'));
});

test('managed image build uses the per-case baseImage and emits baseSetup before recipes', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {}, builtIns: builtInAdapters });

  const docker: DockerConfig = {
    baseImage: 'public.ecr.aws/example/task-a:latest',
    baseSetup: ['command -v node || install-node'],
    repoPath: '/app',
    home: '/home/harness',
    configRoot: '/agent-config',
    timeoutMs: 1000,
    envAllowlist: [],
  };

  const result = await resolveDockerImage({
    projectRoot: root,
    docker,
    selectedAgents: [{ agentName: 'cmd', agent: { adapter: 'command', command: 'echo' } }],
    adapterRegistry: registry,
  });

  expect(result.mode).toBe('managed');
  const dockerfile = await readGeneratedDockerfile(root, result.cacheKey!);
  expect(dockerfile).toContain('FROM public.ecr.aws/example/task-a:latest');
  expect(dockerfile).toContain('RUN command -v node || install-node');
  // baseSetup must come before WORKDIR-following recipe commands but after the base image line.
  expect(dockerfile.indexOf('RUN command -v node')).toBeGreaterThan(dockerfile.indexOf('FROM public.ecr.aws'));
});

test('verifier mounts assetsDir read-only at the verifier target only', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const workspaceDir = join(root, 'workspace');
  const configDir = join(root, 'config');
  const assetsDir = join(root, 'assets', 'task-a', 'tests');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, 'run.sh'), '#!/bin/bash\necho hi\n');

  const workspace: WorkspaceConfig = { source: '.', mode: 'copy', containerPath: '/app', ignore: [] };
  const docker: DockerConfig = { repoPath: '/app', home: '/home/harness', configRoot: '/agent-config', timeoutMs: 1000, envAllowlist: [] };

  await runVerifier({
    verifier: {
      command: 'bash',
      args: ['/tests/run.sh'],
      cwd: '/app',
      assetsDir,
      assetsTarget: '/tests',
      rewardFile: '.reward.txt',
      rewardFormat: 'text',
      network: { mode: 'none' },
    },
    dockerImage: 'task-image',
    workspaceDir,
    configDir,
    workspace,
    docker,
    projectRoot: root,
    caseId: 'task-a',
    agentName: 'cmd',
  });

  const runArgs = (await readDockerLog(root)).find((args) => args[0] === 'run');
  expect(runArgs).toBeDefined();
  const mountFlag = `type=bind,source=${assetsDir},target=/tests,readonly`;
  expect(runArgs).toContain(mountFlag);
  expect(runArgs).toContain('none'); // --network none
});

async function readGeneratedDockerfile(root: string, cacheKey: string): Promise<string> {
  const dir = join(root, '.harness-evals/image-cache', cacheKey);
  return readFile(join(dir, 'Dockerfile'), 'utf8');
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-deepswe-'));
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

// Minimal fake docker: logs args, never starts a container. `build` always
// succeeds, `image inspect` always misses (forces a build), `run`/`create`/
// `cp`/`rm` succeed.
const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.env.FAKE_DOCKER_ROOT;
if (!root) { console.error('FAKE_DOCKER_ROOT required'); process.exit(1); }
const args = process.argv.slice(2);
appendFileSync(join(root, 'fake-docker.log'), JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') process.exit(1);
if (args[0] === 'create') { console.log('fakecontainerid'); process.exit(0); }
if (args[0] === 'build' || args[0] === 'cp' || args[0] === 'rm' || args[0] === 'run') process.exit(0);
console.error('Unsupported fake docker args: ' + args.join(' '));
process.exit(1);
`;
