import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHarnessConfig } from '../src/config/load.js';
import { buildDockerArgs } from '../src/docker/args.js';
import { parsePiEvents } from '../src/events/pi.js';
import { redactionsFromValues, redactString } from '../src/redaction.js';
import { runAssertions } from '../src/assertions/builtins.js';
import { copyWorkspace } from '../src/workspace/copy.js';
import { snapshotWorkspace } from '../src/workspace/snapshot.js';
import { diffWorkspace } from '../src/workspace/diff.js';
import { buildMatrix } from '../src/runner/matrix.js';

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
  - file: cases/*.yaml
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
  expect(matrix[0].agent.args).toEqual(['test-base']);
  expect(matrix[0].agent.model).toBe('cli-model');
  expect(matrix[0].agent.config).toEqual({ a: 1, b: 2 });
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
  - file: cases/*.yaml
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

test('workspace copy and diff ignore generated paths', async () => {
  const root = await tempRoot();
  const source = join(root, 'source');
  const dest = join(root, 'dest');
  await mkdir(join(source, 'node_modules'), { recursive: true });
  await writeFile(join(source, 'README.md'), 'one');
  await writeFile(join(source, 'node_modules', 'ignored.txt'), 'ignored');

  await copyWorkspace(source, dest, { ignore: ['node_modules'] });
  const before = await snapshotWorkspace(dest, ['node_modules']);
  await writeFile(join(dest, 'README.md'), 'two');
  await writeFile(join(dest, 'new.txt'), 'new');
  const after = await snapshotWorkspace(dest, ['node_modules']);

  expect(before).toEqual({ 'README.md': expect.any(String) });
  expect(diffWorkspace(before, after)).toEqual({ added: ['new.txt'], changed: ['README.md'], deleted: [] });
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

test('redaction replaces secret values', () => {
  const redactions = redactionsFromValues([{ name: 'OPENAI_API_KEY', value: 'secret' }]);
  expect(redactString('value=secret', redactions)).toBe('value=<redacted:OPENAI_API_KEY>');
});

test('pi JSONL event parser normalizes tool calls and output', () => {
  const summary = parsePiEvents([
    JSON.stringify({ type: 'tool_execution_start', toolCallId: '1', toolName: 'todo_write', args: { content: 'Run smoke eval' } }),
    JSON.stringify({ type: 'tool_execution_end', toolCallId: '1', toolName: 'todo_write', result: { ok: true }, isError: false }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'OK' }] }] }),
  ].join('\n'));

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

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-'));
  tempDirs.push(path);
  return path;
}
