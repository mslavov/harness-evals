import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHarnessConfig } from '../src/config/load.js';
import { buildDockerArgs } from '../src/docker/args.js';
import { piAdapter } from '../src/adapters/pi.js';
import { redactionsFromValues, redactString } from '../src/redaction.js';
import { runAssertions } from '../src/assertions/builtins.js';
import { copyWorkspace } from '../src/workspace/copy.js';
import { snapshotWorkspace } from '../src/workspace/snapshot.js';
import { diffWorkspace } from '../src/workspace/diff.js';
import { buildMatrix } from '../src/runner/matrix.js';
import { builtInAdapters, createAdapterRegistry } from '../src/adapters/registry.js';
import { runHarness } from '../src/runner/evaluate.js';
import { createOutputDispatcher } from '../src/output/dispatcher.js';
import { createFileOutputProvider } from '../src/output/file-provider.js';
import { createOutputProviderRegistry } from '../src/output/registry.js';
import type { OutputProvider } from '../src/output/types.js';
import { buildRunReport } from '../src/visualization/report.js';
import { renderReport } from '../src/visualization/render.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('config merge order and agent matrix expansion', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'cases'));
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  base:
    adapter: command
    command: echo
    model: root-model
    args: [root]
  child:
    extends: base
    model: child-model
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: merge
prompt: hi
args: [test-base]
agents:
  include: [base]
  overrides:
    "*":
      model: wildcard-model
      config:
        a: 1
    base:
      model: named-model
      config:
        b: 2
assert: []
`);

  const config = await loadHarnessConfig({ cwd: root });
  const matrix = buildMatrix(config, { model: 'cli-model' });

  expect(config.agents.child.adapter).toBe('command');
  expect(matrix).toHaveLength(1);
  expect(matrix[0].agent.args).toEqual(['root']);
  expect(matrix[0].agent.model).toBe('cli-model');
  expect(matrix[0].agent.config).toEqual({ a: 1, b: 2 });
});

test('documented config and test case shapes load', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'evals', 'tests'), { recursive: true });
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
adapters:
  acme-code:
    module: ./evals/adapters/acme-code.js
    export: default
mocks:
  root: evals/mocks
  strict: true
  recordCalls: true
output:
  providers:
    - type: file
    - type: postgres
      module: ./evals/output/postgres-output.js
      config:
        connectionEnv: HARNESS_EVALS_DATABASE_URL
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
judge:
  provider: openai
  model: gpt-4.1
  apiKeyEnv: OPENAI_API_KEY
  temperature: 0
scoring:
  assertionPassRate:
    weight: 0.5
  judgeScore:
    weight: 0.4
  cost:
    weight: 0.1
    target: minimize
    best: 0
    worst: 1.0
agents:
  pi-gemini:
    adapter: pi
    model: gemini-2.5-pro
  claude-sonnet:
    adapter: command
    command: echo
`);
  await writeFile(join(root, 'evals', 'tests', 'quick-smoke.yaml'), `
id: quick-smoke
prompt: Say OK and do not edit files.
assert:
  - type: contains
    value: OK
  - type: workspaceDiff
    changedFiles: []
`);
  await writeFile(join(root, 'evals', 'tests', 'checkout-refactor.yaml'), `
id: checkout-refactor
description: Refactor checkout flow across multiple prompts
attempts: 2
workspace:
  fixture: evals/fixtures/checkout
agents:
  include: [pi-gemini, claude-sonnet]
mocks:
  cli:
    jira-cli: jira-cloud-success
verifier:
  command: bun
  args: [test]
  rewardFile: evals/reward.txt
  rewardFormat: text
  hiddenPatch: evals/patches/hidden.patch
  captureModelPatch: true
  network:
    mode: allowlist
    allow: [registry.npmjs.org]
steps:
  - id: plan
    prompt: Review the checkout module and propose a minimal refactor plan.
    assert:
      - type: contains
        value: refactor
  - id: implement
    prompt: Implement the approved minimal refactor.
    assert:
      - type: exitCode
        equals: 0
      - type: workspaceDiff
        minChanged: 1
  - id: polish
    prompt: Run checks and fix any issues.
    mocks:
      mcp:
        github: github-success
    assert:
      - type: noToolErrors
`);

  const config = await loadHarnessConfig({ cwd: root });
  const quick = config.testCases.find((testCase) => testCase.id === 'quick-smoke');
  const multi = config.testCases.find((testCase) => testCase.id === 'checkout-refactor');

  expect(config.tests).toEqual(['evals/tests/**/*.yaml']);
  expect(config.docker.image).toBeUndefined();
  expect(config.adapters['acme-code']).toEqual({ module: './evals/adapters/acme-code.js', export: 'default' });
  expect(config.mocks.root).toBe(join(root, 'evals', 'mocks'));
  expect(config.output.providers[1].type).toBe('postgres');
  expect(config.visualization.formats).toEqual(['html', 'json', 'csv']);
  expect(config.scoring.cost).toEqual({ weight: 0.1, target: 'minimize', best: 0, worst: 1 });
  expect(quick?.steps).toHaveLength(1);
  expect(quick?.steps[0].id).toBe('run');
  expect(quick?.prompt).toBe('Say OK and do not edit files.');
  expect(multi?.workspace?.fixture).toBe(join(root, 'evals', 'fixtures', 'checkout'));
  expect(multi?.mocks?.cli).toEqual({ 'jira-cli': 'jira-cloud-success' });
  expect(multi?.attempts).toBe(2);
  expect(multi?.verifier).toMatchObject({
    command: 'bun',
    args: ['test'],
    rewardFile: 'evals/reward.txt',
    rewardFormat: 'text',
    hiddenPatch: join(root, 'evals', 'patches', 'hidden.patch'),
    captureModelPatch: true,
    network: { mode: 'allowlist', allow: ['registry.npmjs.org'] },
  });
  expect(multi?.steps.map((step) => step.id)).toEqual(['plan', 'implement', 'polish']);
});

test('default llmJudge runtime dependency is declared', async () => {
  const root = join(import.meta.dir, '..');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };

  expect(packageJson.dependencies).toHaveProperty('@earendil-works/pi-ai');
});

test('packaged skill exposes public docs index and safe onboarding guidance', async () => {
  const root = join(import.meta.dir, '..');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { files: string[]; keywords: string[] };
  const skill = await readFile(join(root, 'skills', 'harness-evals', 'SKILL.md'), 'utf8');
  const docsDir = join(root, 'skills', 'harness-evals', 'docs');
  const publicDocs = [
    'index.md',
    'getting-started.md',
    'installation-and-configuration.md',
    'concepts.md',
    'cli-reference.md',
    'writing-evals.md',
    'use-cases.md',
    'agents-and-adapters.md',
    'docker-workspaces-and-images.md',
    'mocks.md',
    'scoring-and-judging.md',
    'output-and-reports.md',
    'troubleshooting.md',
  ];

  expect(packageJson.files).toContain('skills');
  expect(packageJson.files).not.toContain('docs');
  expect(packageJson.keywords).toContain('skills');
  expect(skill).toContain('name: harness-evals');
  expect(skill).toContain('docs/index.md');
  expect(skill).toContain('docs/cli-reference.md');
  expect(skill).not.toContain(['HDL', 'md'].join('.'));
  expect(skill).not.toContain('L' + 'LD');
  expect(skill).not.toContain(['docs', 'lld'].join('/'));
  expect(skill).toContain('Ask one focused question at a time');
  expect(skill).toContain('Create only goal-specific cases');
  expect(skill).toContain('Never write API keys, tokens, passwords, or secret values into repo files');
  expect(skill).not.toContain('harness-evals init');
  expect(skill).not.toContain('starter-smoke');
  for (const doc of publicDocs) expect(existsSync(join(docsDir, doc))).toBe(true);
  const bundledDocsText = (await Promise.all(publicDocs.map((doc) => readFile(join(docsDir, doc), 'utf8')))).join('\n');
  expect(bundledDocsText).not.toContain('harness-evals init');
  expect(bundledDocsText).not.toContain('starter-smoke');
  expect(existsSync(join(docsDir, 'HDL.md'))).toBe(false);
  expect(existsSync(join(docsDir, 'lld'))).toBe(false);
});

test('adapter registry lists built-ins and allows project overrides', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'evals', 'adapters'), { recursive: true });
  await writeFile(join(root, 'evals', 'adapters', 'command.mjs'), `
export const replacement = {
  name: 'command',
  version: 'project-command',
  async prepareStep() {
    return { argv: ['echo', 'project'], cwd: '/workspace', envNames: [], configMounts: [], parser: 'text' };
  },
  async parseEvents() {
    return { finalOutput: 'project', toolCalls: [], errors: [] };
  },
};
`);

  const builtInRegistry = await createAdapterRegistry({ projectRoot: root, declarations: {} });
  for (const adapter of builtInAdapters) {
    expect(builtInRegistry.list()).toContainEqual(expect.objectContaining({ name: adapter.name, source: 'built-in' }));
  }

  const projectRegistry = await createAdapterRegistry({
    projectRoot: root,
    declarations: { command: { module: './evals/adapters/command.mjs', export: 'replacement' } },
  });

  expect(projectRegistry.require('command').version).toBe('project-command');
  expect(projectRegistry.list()).toContainEqual({
    name: 'command',
    source: 'project',
    module: './evals/adapters/command.mjs',
    version: 'project-command',
  });
});

test('adapter registry rejects unknown and invalid adapters before execution', async () => {
  const root = await tempRoot();
  const registry = await createAdapterRegistry({ projectRoot: root, declarations: {} });
  expect(() => registry.require('missing')).toThrow('Unknown adapter: missing');

  await writeFile(join(root, 'bad-adapter.mjs'), `
export default {
  name: 'bad',
  async prepareStep() {
    return { argv: ['echo'], cwd: '/workspace', envNames: [], configMounts: [], parser: 'text' };
  },
};
`);
  await expect(createAdapterRegistry({
    projectRoot: root,
    declarations: { bad: { module: './bad-adapter.mjs' } },
  })).rejects.toThrow('adapters.bad.parseEvents must be a function');

  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: missing
`);
  await expect(runHarness({ cwd: root })).rejects.toThrow('Unknown adapter: missing');
});

test('MCP mocks fail actionably for adapters without support', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'cases'));
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: command
    command: echo
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: mcp-unsupported
prompt: hi
mocks:
  mcp:
    github: github-success
assert: []
`);

  const result = await runHarness({ cwd: root });

  expect(result.pass).toBe(false);
  expect(result.results[0].error).toContain('does not support applyMcpMocks');
  const records = (await readFile(join(result.results[0].runDir, 'records.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const reportRecord = records.find((record) => record.type === 'visualization.report');
  expect(reportRecord?.payload).toMatchObject({
    status: 'rendered',
    scope: 'run',
    formats: ['html'],
    files: [{ format: 'html', path: join(result.results[0].runDir, 'index.html') }],
  });
});

test('path traversal is rejected for fixtures', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'cases'));
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: command
    command: echo
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: escape
workspace:
  fixture: ../outside
prompt: hi
assert: []
`);

  await expect(loadHarnessConfig({ cwd: root })).rejects.toThrow('Path escapes project root');
});

test('path traversal is rejected for test file globs and mock fixtures', async () => {
  const globRoot = await tempRoot();
  await writeFile(join(globRoot, 'harness-evals.yaml'), `
version: 1
tests:
  - ../outside/*.yaml
`);
  await expect(loadHarnessConfig({ cwd: globRoot })).rejects.toThrow('path traversal');

  const mockRoot = await tempRoot();
  await mkdir(join(mockRoot, 'evals', 'tests'), { recursive: true });
  await writeFile(join(mockRoot, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: command
    command: echo
tests:
  - evals/tests/*.yaml
`);
  await writeFile(join(mockRoot, 'evals', 'tests', 'case.yaml'), `
id: mock-escape
prompt: hi
mocks:
  cli:
    jira-cli: ../outside
assert: []
`);

  await expect(loadHarnessConfig({ cwd: mockRoot })).rejects.toThrow('Path escapes project root');
});

test('unknown config extension keys and assertion types fail during loading', async () => {
  const invalids = [
    {
      config: `adapters:\n  bad:\n    module: ./adapter.js\n    unexpected: true`,
      message: 'Unknown adapters.bad key',
    },
    {
      config: `output:\n  providers:\n    - type: file\n      unexpected: true`,
      message: 'Unknown output.providers[0] key',
    },
    {
      config: `visualization:\n  theme: dark`,
      message: 'Unknown visualization key',
    },
    {
      config: `scoring:\n  exactness:\n    weight: 1`,
      message: 'Unknown scoring key',
    },
    {
      caseYaml: `id: bad-assert\nprompt: hi\nassert:\n  - type: notARealAssertion`,
      message: 'Unknown assertion type',
    },
    {
      caseYaml: `id: bad-judge\nprompt: hi\nassert:\n  - type: llmJudge\n    judge:\n      provider: test\n      model: judge\n      apiKeyEnv: TEST_KEY\n      rubric: Score it.\n      inputs: [finalOutput]`,
      message: 'threshold is required',
    },
    {
      caseYaml: `id: bad-judge-input\nprompt: hi\nassert:\n  - type: llmJudge\n    threshold: 0.5\n    judge:\n      provider: test\n      model: judge\n      apiKeyEnv: TEST_KEY\n      rubric: Score it.\n      inputs: [unknownInput]`,
      message: 'unsupported ref',
    },
    {
      caseYaml: `id: bad-judge-defaults\nprompt: hi\nassert:\n  - type: llmJudge\n    threshold: 0.5\n    judge:\n      provider: test\n      rubric: Score it.\n      inputs: [finalOutput]`,
      message: 'requires judge.model',
    },
    {
      caseYaml: `id: bad-attempts\nprompt: hi\nattempts: 0\nassert: []`,
      message: 'attempts must be a positive integer',
    },
    {
      caseYaml: `id: bad-reward\nprompt: hi\nverifier:\n  command: bun\n  rewardFile: ../reward.txt\nassert: []`,
      message: 'verifier.rewardFile may not contain path traversal',
    },
    {
      caseYaml: `id: bad-hidden-patch\nprompt: hi\nverifier:\n  command: bun\n  hiddenPatch: /tmp/hidden.patch\nassert: []`,
      message: 'verifier.hiddenPatch must be project-relative',
    },
    {
      caseYaml: `id: bad-network\nprompt: hi\nverifier:\n  command: bun\n  network:\n    mode: tunnel\nassert: []`,
      message: 'verifier.network.mode must be one of',
    },
  ];

  for (const invalid of invalids) {
    const root = await tempRoot();
    await mkdir(join(root, 'evals', 'tests'), { recursive: true });
    await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: command
    command: echo
tests:
  - evals/tests/*.yaml
${invalid.config ?? ''}
`);
    await writeFile(join(root, 'evals', 'tests', 'case.yaml'), invalid.caseYaml ?? `
id: valid
prompt: hi
assert: []
`);

    await expect(loadHarnessConfig({ cwd: root })).rejects.toThrow(invalid.message);
  }
});

test('workspace copy and diff ignore generated paths', async () => {
  const root = await tempRoot();
  const source = join(root, 'source');
  const dest = join(root, 'dest');
  await mkdir(join(source, 'node_modules'), { recursive: true });
  await mkdir(join(source, 'evals', 'output'), { recursive: true });
  await mkdir(join(source, 'evals', 'runs', 'latest'), { recursive: true });
  await mkdir(join(source, 'logs'), { recursive: true });
  await writeFile(join(source, 'README.md'), 'one');
  await writeFile(join(source, 'node_modules', 'ignored.txt'), 'ignored');
  await writeFile(join(source, 'evals', 'output', 'old.json'), 'ignored');
  await writeFile(join(source, 'evals', 'runs', 'latest', 'old.json'), 'ignored');
  await writeFile(join(source, 'logs', 'old.tmp'), 'ignored');

  const ignore = ['node_modules', 'evals/output', 'evals/runs/**', 'logs/*.tmp'];
  await copyWorkspace(source, dest, { ignore });
  const before = await snapshotWorkspace(dest, ignore);
  await writeFile(join(dest, 'README.md'), 'two');
  await writeFile(join(dest, 'new.txt'), 'new');
  await mkdir(join(dest, 'evals', 'output'), { recursive: true });
  await mkdir(join(dest, 'evals', 'runs', 'current'), { recursive: true });
  await writeFile(join(dest, 'evals', 'output', 'new.json'), 'ignored');
  await writeFile(join(dest, 'evals', 'runs', 'current', 'new.json'), 'ignored');
  await writeFile(join(dest, 'logs', 'new.tmp'), 'ignored');
  const after = await snapshotWorkspace(dest, ignore);

  expect(before).toEqual({ 'README.md': expect.any(String) });
  expect(diffWorkspace(before, after)).toEqual({ added: ['new.txt'], changed: ['README.md'], deleted: [] });
});

test('step ids that map to the same artifact id are rejected', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'evals', 'tests'), { recursive: true });
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: command
    command: echo
tests:
  - evals/tests/*.yaml
`);
  await writeFile(join(root, 'evals', 'tests', 'case.yaml'), `
id: duplicate-steps
steps:
  - id: Run Step
    prompt: one
  - id: run-step
    prompt: two
assert: []
`);

  await expect(loadHarnessConfig({ cwd: root })).rejects.toThrow('both map to artifact id "run-step"');
});

test('docker args include copied workspace and env allowlist', () => {
  const args = buildDockerArgs({
    image: 'image',
    containerName: 'case',
    workdir: '/workspace',
    home: '/home/harness',
    workspaceMount: { source: '/host/workspace', target: '/workspace', readonly: false },
    configMount: { source: '/host/config', target: '/agent-config', readonly: false },
    configMounts: [{ source: '/host/ro', target: '/ro', readonly: true }],
    envNames: ['OPENAI_API_KEY'],
    argv: ['echo', 'hi'],
  });

  expect(args).toContain('type=bind,source=/host/workspace,target=/workspace');
  expect(args).toContain('type=bind,source=/host/ro,target=/ro,readonly');
  expect(args).toContain('OPENAI_API_KEY');
  expect(args.slice(-3)).toEqual(['image', 'echo', 'hi']);
});

test('docker args include network policy controls', () => {
  const args = buildDockerArgs({
    image: 'image',
    containerName: 'case',
    workdir: '/workspace',
    home: '/home/harness',
    workspaceMount: { source: '/host/workspace', target: '/workspace', readonly: false },
    configMount: { source: '/host/config', target: '/agent-config', readonly: false },
    configMounts: [],
    envNames: [],
    network: { mode: 'none' },
    argv: ['echo', 'hi'],
  });

  expect(args).toContain('--network');
  expect(args).toContain('none');
  expect(args.slice(-3)).toEqual(['image', 'echo', 'hi']);
});

test('redaction replaces secret values', () => {
  const redactions = redactionsFromValues([{ name: 'OPENAI_API_KEY', value: 'secret' }]);
  expect(redactString('value=secret', redactions)).toBe('value=<redacted:OPENAI_API_KEY>');
});

test('output dispatcher sequences redacted records and records secondary provider failures', async () => {
  const root = await tempRoot();
  const runDir = join(root, '.harness-evals', 'runs', 'case-agent-now');
  const outputRoot = join(root, '.harness-evals', 'output');
  const failingProvider: OutputProvider = {
    type: 'secondary',
    async initialize() {},
    async write() {
      throw new Error('secondary unavailable');
    },
    async finalize() {},
  };

  const dispatcher = await createOutputDispatcher({
    projectRoot: root,
    runId: 'run-1',
    scenarioId: 'case',
    agentName: 'agent',
    redactions: redactionsFromValues([{ name: 'SECRET_TOKEN', value: 'secret' }]),
    providers: [
      { provider: createFileOutputProvider({ projectRoot: root, outputRoot, runDir }) },
      { provider: failingProvider },
    ],
  });

  const first = await dispatcher.emit({ type: 'run.started', payload: { token: 'secret' } });
  const second = await dispatcher.emit({ type: 'step.stdout', stepId: 'Run Step', payload: 'hello secret' });
  await dispatcher.finalize({ status: 'passed' });

  expect(first.sequence).toBe(1);
  expect(second.sequence).toBe(2);
  expect(first.redacted).toBe(true);
  expect(dispatcher.providerFailures).toContainEqual(expect.objectContaining({ provider: 'secondary', operation: 'write', sequence: 1 }));
  expect(dispatcher.providerFailures).toContainEqual(expect.objectContaining({ provider: 'secondary', operation: 'write', sequence: 2 }));

  const stdout = await readFile(join(runDir, 'steps', 'run-step', 'stdout.log'), 'utf8');
  const records = (await readFile(join(runDir, 'records.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(stdout).toBe('hello <redacted:SECRET_TOKEN>\n');
  expect(records.map((record) => record.sequence)).toEqual([1, 2]);
  expect(records[0].payload.token).toBe('<redacted:SECRET_TOKEN>');
});

test('file output provider owns default run layout and latest summary files', async () => {
  const root = await tempRoot();
  const outputRoot = join(root, '.harness-evals', 'output');
  const runDir = join(root, '.harness-evals', 'runs', 'case-agent-now');
  const registry = await createOutputProviderRegistry({ projectRoot: root, outputRoot, providers: [] });
  const dispatcher = await createOutputDispatcher({
    projectRoot: root,
    runId: 'case-agent-now',
    scenarioId: 'case',
    agentName: 'agent',
    redactions: [],
    providers: registry.create({ runId: 'case-agent-now', runDir, scenarioId: 'case', agentName: 'agent' }),
  });

  await dispatcher.emit({ type: 'run.started', payload: { caseId: 'case', agentName: 'agent' } });
  await dispatcher.emit({ type: 'image.resolution', payload: { mode: 'ready', image: 'node:22' } });
  await dispatcher.emit({ type: 'mock.config', payload: { testCase: { cli: { gh: 'success' } } } });
  await dispatcher.emit({ type: 'step.started', stepId: 'run', payload: { stepId: 'run' } });
  await dispatcher.emit({ type: 'step.command', stepId: 'run', payload: { command: ['docker', 'run'], env: {} } });
  await dispatcher.emit({ type: 'step.stdout', stepId: 'run', payload: 'OK' });
  await dispatcher.emit({ type: 'step.stderr', stepId: 'run', payload: '' });
  await dispatcher.emit({ type: 'step.events', stepId: 'run', payload: { finalOutput: 'OK', toolCalls: [], errors: [] } });
  await dispatcher.emit({ type: 'step.assertions', stepId: 'run', payload: [{ type: 'contains', pass: true, required: true, reason: 'ok' }] });
  await dispatcher.emit({ type: 'step.completed', stepId: 'run', payload: { pass: true, exitCode: 0, durationMs: 1 } });
  await dispatcher.emit({ type: 'workspace.diff', payload: { added: [], changed: [], deleted: [] } });
  await dispatcher.emit({ type: 'run.result', payload: { caseId: 'case', agentName: 'agent', pass: true } });
  await dispatcher.emit({ type: 'run.summary', payload: { pass: true, results: [{ caseId: 'case', agentName: 'agent', pass: true, exitCode: 0, durationMs: 1 }] } });
  await dispatcher.finalize({ status: 'passed' });

  expect(JSON.parse(await readFile(join(runDir, 'image-resolution.json'), 'utf8')).image).toBe('node:22');
  expect(JSON.parse(await readFile(join(runDir, 'steps', 'run', 'command.redacted.json'), 'utf8')).command).toEqual(['docker', 'run']);
  expect(await readFile(join(runDir, 'steps', 'run', 'stdout.log'), 'utf8')).toBe('OK\n');
  expect(JSON.parse(await readFile(join(runDir, 'steps', 'run', 'assertions.json'), 'utf8'))[0].pass).toBe(true);
  const latestReport = JSON.parse(await readFile(join(outputRoot, 'latest', 'results.json'), 'utf8'));
  expect(latestReport.status).toBe('passed');
  expect(await readFile(join(outputRoot, 'latest', 'results.html'), 'utf8')).toContain('Harness Evals Results: PASSED');
  expect(await readFile(join(outputRoot, 'latest', 'results.csv'), 'utf8')).toContain('runId,testCaseId,suite,agentName');
  expect(await readFile(join(runDir, 'index.html'), 'utf8')).toContain('Harness Evals Results: PASSED');
});

test('file output provider honors visualization disabled, formats, and latest config', async () => {
  const root = await tempRoot();
  const disabledOutputRoot = join(root, 'disabled', 'output');
  const disabledRunDir = join(root, 'disabled', 'runs', 'case-agent-now');
  const disabledRegistry = await createOutputProviderRegistry({
    projectRoot: root,
    outputRoot: disabledOutputRoot,
    providers: [],
    visualization: visualizationConfig({ enabled: false }),
  });
  const disabledDispatcher = await createOutputDispatcher({
    projectRoot: root,
    runId: 'case-agent-now',
    scenarioId: 'case',
    agentName: 'agent',
    redactions: [],
    providers: disabledRegistry.create({ runId: 'case-agent-now', runDir: disabledRunDir, scenarioId: 'case', agentName: 'agent' }),
  });

  await disabledDispatcher.emit({ type: 'run.result', payload: { caseId: 'case', agentName: 'agent', pass: true } });
  await disabledDispatcher.emit({ type: 'run.summary', payload: { pass: true, results: [{ caseId: 'case', agentName: 'agent', pass: true }] } });
  await disabledDispatcher.finalize({ status: 'passed' });

  expect(existsSync(join(disabledRunDir, 'result.json'))).toBe(true);
  expect(existsSync(join(disabledRunDir, 'index.html'))).toBe(false);
  expect(existsSync(join(disabledOutputRoot, 'latest', 'results.json'))).toBe(false);

  const csvOutputRoot = join(root, 'csv', 'output');
  const csvRunDir = join(root, 'csv', 'runs', 'case-agent-now');
  const csvRegistry = await createOutputProviderRegistry({
    projectRoot: root,
    outputRoot: csvOutputRoot,
    providers: [],
    visualization: visualizationConfig({ formats: ['csv'] }),
  });
  const csvDispatcher = await createOutputDispatcher({
    projectRoot: root,
    runId: 'case-agent-now',
    scenarioId: 'case',
    agentName: 'agent',
    redactions: [],
    providers: csvRegistry.create({ runId: 'case-agent-now', runDir: csvRunDir, scenarioId: 'case', agentName: 'agent' }),
  });

  await csvDispatcher.emit({ type: 'run.result', payload: { caseId: 'case', agentName: 'agent', pass: true } });
  await csvDispatcher.emit({ type: 'run.summary', payload: { pass: true, results: [{ caseId: 'case', agentName: 'agent', pass: true }] } });
  await csvDispatcher.finalize({ status: 'passed' });

  expect(existsSync(join(csvRunDir, 'index.html'))).toBe(false);
  expect(existsSync(join(csvOutputRoot, 'latest', 'results.csv'))).toBe(true);
  expect(existsSync(join(csvOutputRoot, 'latest', 'results.json'))).toBe(false);
  expect(existsSync(join(csvOutputRoot, 'latest', 'results.html'))).toBe(false);

  const noLatestOutputRoot = join(root, 'no-latest', 'output');
  const noLatestRegistry = await createOutputProviderRegistry({
    projectRoot: root,
    outputRoot: noLatestOutputRoot,
    providers: [],
    visualization: visualizationConfig({ latest: false }),
  });
  const noLatestDispatcher = await createOutputDispatcher({
    projectRoot: root,
    runId: 'case-agent-now',
    scenarioId: 'case',
    agentName: 'agent',
    redactions: [],
    providers: noLatestRegistry.create({ runId: 'case-agent-now', runDir: join(root, 'no-latest', 'runs', 'case-agent-now'), scenarioId: 'case', agentName: 'agent' }),
  });

  await noLatestDispatcher.emit({ type: 'run.summary', payload: { pass: true, results: [{ caseId: 'case', agentName: 'agent', pass: true }] } });
  await noLatestDispatcher.finalize({ status: 'passed' });

  expect(existsSync(join(noLatestOutputRoot, 'latest', 'results.json'))).toBe(false);
});

test('CLI list accepts refresh managed image flag', async () => {
  const root = await tempRoot();
  const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
  await mkdir(join(root, 'cases'));
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: command
    command: echo
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: cli-list
prompt: hi
assert: []
`);

  const listed = Bun.spawnSync(['bun', cliPath, 'list', '--refresh-managed-image', '--config', join(root, 'harness-evals.yaml')], { cwd: root });

  expect(listed.exitCode).toBe(0);
  expect(new TextDecoder().decode(listed.stdout)).toContain('Runtime image: managed (will refresh before run)');
});

test('CLI export honors enabled visualization formats', async () => {
  const root = await tempRoot();
  const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
  const outputRoot = join(root, '.harness-evals', 'output', 'latest');
  const exported = join(root, 'exported.json');
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
visualization:
  formats: [json]
`);
  await writeFile(join(outputRoot, 'results.json'), '{"status":"passed"}\n');

  const jsonExport = Bun.spawnSync(['bun', cliPath, 'export', '--config', join(root, 'harness-evals.yaml'), '--format', 'json', '--output', exported], { cwd: root });
  expect(jsonExport.exitCode).toBe(0);
  expect(await readFile(exported, 'utf8')).toBe('{"status":"passed"}\n');

  const csvExport = Bun.spawnSync(['bun', cliPath, 'export', '--config', join(root, 'harness-evals.yaml'), '--format', 'csv', '--output', join(root, 'exported.csv')], { cwd: root });
  expect(csvExport.exitCode).toBe(1);
  expect(new TextDecoder().decode(csvExport.stderr)).toContain('Visualization format is not enabled: csv');
});

test('visualization report compares agents and exposes triage details', () => {
  const report = buildRunReport({
    pass: false,
    cost: costSummary(0.03, 300),
    results: [
      reportResult('case-a', 'agent-a', true, 0.9, 10, { added: ['a.txt'], changed: [], deleted: [] }),
      reportResult('case-a', 'agent-b', false, 0.2, 20, { added: [], changed: ['b.txt'], deleted: [] }),
    ],
  }, { runId: 'latest' });

  expect(report.columns.map((column) => column.agentName)).toEqual(['agent-a', 'agent-b']);
  expect(report.rows).toHaveLength(1);
  expect(report.rows[0].cells['agent-b|openai|gpt-4.1'].assertionSummary.requiredFailed).toBe(1);
  expect(report.rows[0].cells['agent-b|openai|gpt-4.1'].details.toolCalls).toEqual([{ name: 'edit', args: { path: 'b.txt' } }]);
  expect(report.rows[0].cells['agent-b|openai|gpt-4.1'].details.mockCalls).toEqual([{ name: 'gh', count: 1 }]);
  expect(report.rows[0].cells['agent-b|openai|gpt-4.1'].details.workspaceDiff).toEqual({ added: [], changed: ['b.txt'], deleted: [] });
});

test('visualization include controls report details', () => {
  const report = buildRunReport({
    pass: false,
    results: [reportResult('case-a', 'agent-b', false, 0.2, 20, { added: [], changed: ['b.txt'], deleted: [] })],
  }, {
    runId: 'latest',
    include: {
      logs: false,
      workspaceDiff: false,
      toolCalls: false,
      mockCalls: false,
      judgeDetails: false,
    },
  });
  const details = report.rows[0].cells['agent-b|openai|gpt-4.1'].details;
  const html = renderReport(report, 'html');

  expect(details.logs).toBeUndefined();
  expect(details.workspaceDiff).toBeUndefined();
  expect(details.toolCalls).toBeUndefined();
  expect(details.mockCalls).toBeUndefined();
  expect(details.judgeResults).toBeUndefined();
  expect(html).toContain('<h4>Steps</h4>');
  expect(html).not.toContain('<h4>Tool calls</h4>');
  expect(html).not.toContain('<h4>Mock calls</h4>');
  expect(html).not.toContain('<h4>Judge results</h4>');
  expect(html).not.toContain('<h4>Workspace diff</h4>');
  expect(html).not.toContain('<h4>Logs</h4>');
});

test('custom output providers load from project modules with named exports', async () => {
  const root = await tempRoot();
  const logPath = join(root, 'provider-records.jsonl');
  await writeFile(join(root, 'provider.mjs'), `
export const named = {
  type: 'custom',
  async initialize(input) {
    this.logPath = input.config.logPath;
    const { appendFile } = await import('node:fs/promises');
    await appendFile(this.logPath, JSON.stringify({ event: 'initialize', runId: input.runId }) + '\\n');
  },
  async write(record) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(this.logPath, JSON.stringify({ event: 'write', sequence: record.sequence, type: record.type }) + '\\n');
  },
  async finalize(result) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(this.logPath, JSON.stringify({ event: 'finalize', status: result.status }) + '\\n');
  },
};
`);

  const registry = await createOutputProviderRegistry({
    projectRoot: root,
    outputRoot: join(root, '.harness-evals', 'output'),
    providers: [{ type: 'custom', module: './provider.mjs', export: 'named', config: { logPath } }],
  });
  const dispatcher = await createOutputDispatcher({
    projectRoot: root,
    runId: 'custom-run',
    redactions: [],
    providers: registry.create({ runId: 'custom-run' }),
  });

  await dispatcher.emit({ type: 'run.started', payload: { ok: true } });
  await dispatcher.finalize({ status: 'passed' });

  expect(registry.list()).toEqual([{ type: 'custom', source: 'project', module: './provider.mjs' }]);
  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(records).toEqual([
    { event: 'initialize', runId: 'custom-run' },
    { event: 'write', sequence: 1, type: 'run.started' },
    { event: 'finalize', status: 'passed' },
  ]);
});

test('custom output provider registry creates isolated object provider instances per run', async () => {
  const root = await tempRoot();
  const logPath = join(root, 'provider-state.jsonl');
  await writeFile(join(root, 'stateful-provider.mjs'), `
export const provider = {
  type: 'stateful',
  initialize(input) {
    this.logPath = input.config.logPath;
    this.events = [{ event: 'initialize', runId: input.runId }];
  },
  write(record) {
    this.events.push({ event: 'write', runId: record.runId, sequence: record.sequence });
  },
  async finalize(result) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(this.logPath, JSON.stringify({ runId: result.runId, events: this.events }) + '\\n');
  },
};
`);

  const registry = await createOutputProviderRegistry({
    projectRoot: root,
    outputRoot: join(root, '.harness-evals', 'output'),
    providers: [{ type: 'stateful', module: './stateful-provider.mjs', config: { logPath } }],
  });
  const first = await createOutputDispatcher({
    projectRoot: root,
    runId: 'run-a',
    redactions: [],
    providers: registry.create({ runId: 'run-a' }),
  });
  const second = await createOutputDispatcher({
    projectRoot: root,
    runId: 'run-b',
    redactions: [],
    providers: registry.create({ runId: 'run-b' }),
  });

  await first.emit({ type: 'run.started', payload: { ok: true } });
  await second.emit({ type: 'run.started', payload: { ok: true } });
  await first.finalize({ status: 'passed' });
  await second.finalize({ status: 'passed' });

  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(records).toEqual([
    {
      runId: 'run-a',
      events: [
        { event: 'initialize', runId: 'run-a' },
        { event: 'write', runId: 'run-a', sequence: 1 },
      ],
    },
    {
      runId: 'run-b',
      events: [
        { event: 'initialize', runId: 'run-b' },
        { event: 'write', runId: 'run-b', sequence: 1 },
      ],
    },
  ]);
});

test('custom output providers can export a createProvider factory', async () => {
  const root = await tempRoot();
  const logPath = join(root, 'factory-provider-records.jsonl');
  await writeFile(join(root, 'factory-provider.mjs'), `
export function createProvider() {
  const events = [];
  return {
    type: 'factory',
    initialize(input) {
      this.logPath = input.config.logPath;
      events.push({ event: 'initialize', runId: input.runId });
    },
    write(record) {
      events.push({ event: 'write', runId: record.runId, sequence: record.sequence });
    },
    async finalize(result) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(this.logPath, JSON.stringify({ runId: result.runId, events }) + '\\n');
    },
  };
}
`);

  const registry = await createOutputProviderRegistry({
    projectRoot: root,
    outputRoot: join(root, '.harness-evals', 'output'),
    providers: [{ type: 'factory', module: './factory-provider.mjs', config: { logPath } }],
  });
  const first = await createOutputDispatcher({
    projectRoot: root,
    runId: 'factory-a',
    redactions: [],
    providers: registry.create({ runId: 'factory-a' }),
  });
  const second = await createOutputDispatcher({
    projectRoot: root,
    runId: 'factory-b',
    redactions: [],
    providers: registry.create({ runId: 'factory-b' }),
  });

  await first.emit({ type: 'run.started', payload: { ok: true } });
  await second.emit({ type: 'run.started', payload: { ok: true } });
  await first.finalize({ status: 'passed' });
  await second.finalize({ status: 'passed' });

  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(records).toEqual([
    {
      runId: 'factory-a',
      events: [
        { event: 'initialize', runId: 'factory-a' },
        { event: 'write', runId: 'factory-a', sequence: 1 },
      ],
    },
    {
      runId: 'factory-b',
      events: [
        { event: 'initialize', runId: 'factory-b' },
        { event: 'write', runId: 'factory-b', sequence: 1 },
      ],
    },
  ]);
});

test('pi adapter parses JSONL events into tool calls and output', async () => {
  const summary = await piAdapter.parseEvents({
    stdout: [
      JSON.stringify({ type: 'tool_execution_start', toolCallId: '1', toolName: 'todo_write', args: { content: 'Run smoke eval' } }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: '1', toolName: 'todo_write', result: { ok: true }, isError: false }),
      JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'OK' }] }] }),
    ].join('\n'),
    stderr: '',
  });

  expect(summary.finalOutput).toBe('OK');
  expect(summary.toolCalls).toEqual([{ name: 'todo_write', args: { content: 'Run smoke eval' }, result: { ok: true }, isError: false }]);
});

test('built-in assertions evaluate tool calls and workspace diff', async () => {
  const results = await runAssertions([
    { type: 'exitCode', equals: 0 },
    { type: 'contains', value: 'OK' },
    { type: 'toolCalled', name: 'todo_write', min: 1, max: 1, argsContain: ['Run smoke eval'] },
    { type: 'noToolErrors' },
    { type: 'workspaceDiff', changedFiles: [] },
  ], {
    output: 'OK',
    exitCode: 0,
    events: { finalOutput: 'OK', toolCalls: [{ name: 'todo_write', args: { content: 'Run smoke eval' } }], errors: [] },
    workspace: { added: [], changed: [], deleted: [] },
    metadata: {},
  });

  expect(results.every((result) => result.pass)).toBe(true);
});

function visualizationConfig(overrides: Partial<ReturnType<typeof visualizationConfigBase>> = {}) {
  return {
    ...visualizationConfigBase(),
    ...overrides,
    include: { ...visualizationConfigBase().include, ...(overrides.include ?? {}) },
  };
}

function visualizationConfigBase() {
  return {
    enabled: true,
    formats: ['html', 'json', 'csv'] as Array<'html' | 'json' | 'csv'>,
    latest: true,
    include: {
      logs: true,
      workspaceDiff: true,
      toolCalls: true,
      mockCalls: true,
      judgeDetails: true,
    },
  };
}

function reportResult(caseId: string, agentName: string, pass: boolean, score: number, durationMs: number, workspace: unknown) {
  return {
    caseId,
    agentName,
    status: pass ? 'passed' : 'failed',
    pass,
    durationMs,
    runDir: `/runs/${caseId}-${agentName}`,
    score: { score, maxScore: 1, buckets: [] },
    cost: costSummary(0.01, 100),
    workspace,
    events: { toolCalls: [{ name: 'edit', args: { path: 'b.txt' } }], mockCalls: [{ name: 'gh', count: 1 }], errors: [] },
    assertions: [{ type: 'contains', pass, required: true, reason: pass ? 'ok' : 'missing output' }],
    steps: [{ id: 'run', status: pass ? 'passed' : 'failed', pass, durationMs, events: { toolCalls: [] } }],
  };
}

function costSummary(totalCost: number, totalTokens: number) {
  return {
    available: true,
    currency: 'USD',
    totalCost,
    rollup: { totalCost, totalTokens, currency: 'USD' },
    byProvider: { openai: { totalCost, totalTokens } },
    byModel: { 'gpt-4.1': { totalCost, totalTokens } },
    byAgent: {},
    byScenario: {},
    byTestCase: {},
    byRun: {},
    steps: {},
  };
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-'));
  tempDirs.push(path);
  return path;
}
