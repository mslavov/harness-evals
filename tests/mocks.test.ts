import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentAdapter, type AgentStepPrepareInput, type ApplyMcpMocksInput } from '../src/adapters/types.js';
import { runHarness } from '../src/runner/evaluate.js';

const tempDirs: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('CLI mocks shadow commands, return fixture responses, and record mock calls', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));

  await writeHarnessProject(root, `
id: cli-shadow
mocks:
  cli:
    jira-cli: jira-success
steps:
  - id: run
    prompt: create issue
    config:
      argv: [jira-cli, issue, --project, STORZY, --summary, checkout bug]
    assert:
      - type: contains
        value: STORZY-1
      - type: mockCalled
        name: jira-cli:issue
        surface: cli
        argsContain: [STORZY]
`, {
    'evals/mocks/cli/jira-success.yaml': `
name: jira-success
mocks:
  - id: create-issue
    tool: jira-cli:issue
    match:
      project: STORZY
      summary: '*checkout*'
    response:
      ok: true
      key: STORZY-1
`,
  });

  const result = await runHarness({ cwd: root, adapters: [createMockAdapter()] });
  const run = result.results[0];
  const step = run.steps[0];
  const calls = await readJsonl(join(run.runDir, 'mock-calls.jsonl'));
  const stepCalls = await readJsonl(join(run.runDir, 'steps', 'run', 'mock-calls.jsonl'));

  expect(result.pass).toBe(true);
  expect(step.output).toContain('STORZY-1');
  expect(step.events.mockCalls?.[0]).toMatchObject({ surface: 'cli', name: 'jira-cli:issue', matched: true });
  expect(step.assertions.find((assertion) => assertion.type === 'mockCalled')?.pass).toBe(true);
  expect(calls[0]).toMatchObject({ surface: 'cli', tool: 'jira-cli:issue', matched: true, ruleId: 'create-issue' });
  expect(stepCalls).toHaveLength(1);
  expect(JSON.parse(await readFile(join(run.runDir, 'steps', 'run', 'mock-config.json'), 'utf8')).cli).toEqual({ 'jira-cli': 'jira-success' });
});

test('strict CLI mocks fail unmatched external calls even without explicit assertions', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));

  await writeHarnessProject(root, `
id: strict-unmatched-cli
mocks:
  cli:
    jira-cli: jira-other-project
steps:
  - id: run
    prompt: create issue
    config:
      argv: [jira-cli, issue, --project, STORZY]
    assert: []
`, {
    'evals/mocks/cli/jira-other-project.yaml': `
name: jira-other-project
mocks:
  - id: create-other
    tool: jira-cli:issue
    match:
      project: OTHER
    stdout: other
`,
  });

  const result = await runHarness({ cwd: root, adapters: [createMockAdapter()] });
  const step = result.results[0].steps[0];
  const calls = await readJsonl(join(result.results[0].runDir, 'mock-calls.jsonl'));

  expect(result.pass).toBe(false);
  expect(step.status).toBe('failed');
  expect(step.assertions.some((assertion) => assertion.type === 'error' && assertion.reason?.includes('Unmatched CLI mock call'))).toBe(true);
  expect(calls[0]).toMatchObject({ surface: 'cli', matched: false, strict: true });
});

test('step-level CLI mocks override test-case mocks only for that step', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));

  await writeHarnessProject(root, `
id: step-overrides
mocks:
  cli:
    jira-cli: case-fixture
steps:
  - id: first
    prompt: first
    config:
      argv: [jira-cli]
    assert:
      - type: contains
        value: case mock
  - id: second
    prompt: second
    mocks:
      cli:
        jira-cli: step-fixture
    config:
      argv: [jira-cli]
    assert:
      - type: contains
        value: step mock
`, {
    'evals/mocks/cli/case-fixture.yaml': `
name: case-fixture
mocks:
  - id: case
    tool: jira-cli
    stdout: case mock
`,
    'evals/mocks/cli/step-fixture.yaml': `
name: step-fixture
mocks:
  - id: step
    tool: jira-cli
    stdout: step mock
`,
  });

  const result = await runHarness({ cwd: root, adapters: [createMockAdapter()] });
  const run = result.results[0];
  const calls = await readJsonl(join(run.runDir, 'mock-calls.jsonl'));

  expect(result.pass).toBe(true);
  expect(run.steps.map((step) => step.output)).toEqual(['case mock', 'step mock']);
  expect(calls.map((call) => call.fixtureName)).toEqual(['case-fixture', 'step-fixture']);
});

test('MCP mocks stage wrapper plans, intercept tools/call, and record calls', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const applyInputs: ApplyMcpMocksInput[] = [];

  await writeHarnessProject(root, `
id: mcp-intercept
mocks:
  mcp:
    github: github-success
steps:
  - id: run
    prompt: create issue
    config:
      mode: mcp
      server: github
      tool: create_issue
      arguments:
        title: checkout bug
    assert:
      - type: contains
        value: '42'
      - type: mockCalled
        name: create_issue
        surface: mcp
`, {
    'evals/mocks/mcp/github-success.yaml': `
name: github-success
mocks:
  - id: create-issue
    tool: create_issue
    match:
      title: '*checkout*'
    response:
      number: 42
      url: https://github.example.local/acme/repo/issues/42
`,
  });

  const result = await runHarness({ cwd: root, adapters: [createMockAdapter(applyInputs)] });
  const run = result.results[0];
  const step = run.steps[0];
  const calls = await readJsonl(join(run.runDir, 'mock-calls.jsonl'));

  expect(result.pass).toBe(true);
  expect(applyInputs[0].mcpWrappers.github.wrapperCommand[1]).toBe('/agent-config/mocks/bin/mcp-wrapper.cjs');
  expect(step.output).toContain('42');
  expect(calls[0]).toMatchObject({ surface: 'mcp', tool: 'create_issue', matched: true, ruleId: 'create-issue' });
  expect(step.assertions.find((assertion) => assertion.type === 'mockCalled')?.pass).toBe(true);
});

test('MCP wrappers preserve wrapped server passthrough for unmocked methods and tools', async () => {
  const root = await tempRoot();
  restores.push(await installFakeDocker(root));
  const realServerPath = join(root, 'real-mcp-server.cjs');
  await writeFile(realServerPath, REAL_MCP_SERVER);

  await writeHarnessProject(root, `
id: mcp-passthrough
mocks:
  mcp:
    github: github-success
steps:
  - id: run
    prompt: use mock and real MCP capabilities
    config:
      mode: mcpSequence
      server: github
    assert:
      - type: mockCalled
        name: create_issue
        surface: mcp
`, {
    'evals/mocks/mcp/github-success.yaml': `
name: github-success
mocks:
  - id: create-issue
    tool: create_issue
    match:
      title: '*checkout*'
    response:
      number: 42
`,
  });

  const result = await runHarness({
    cwd: root,
    adapters: [createMockAdapter([], { wrappedMcpCommand: [process.execPath, realServerPath], wrappedMcpEnv: { REAL_MCP_VALUE: 'preserved-env' } })],
  });
  const run = result.results[0];
  const step = run.steps[0];
  const calls = await readJsonl(join(run.runDir, 'mock-calls.jsonl'));
  const output = JSON.parse(step.output) as Record<string, { result?: { tools?: Array<{ name: string }>; prompts?: Array<{ name: string }>; content?: Array<{ text: string }> } }>;

  expect(result.pass).toBe(true);
  expect(output.tools.result?.tools?.map((tool) => tool.name)).toEqual(['list_repos']);
  expect(output.prompts.result?.prompts?.map((prompt) => prompt.name)).toEqual(['triage']);
  expect(output.mocked.result?.content?.[0]?.text).toBe('{"number":42}');
  expect(output.realTool.result?.content?.[0]?.text).toBe('{"repos":["core"],"env":"preserved-env"}');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ surface: 'mcp', tool: 'create_issue', matched: true, ruleId: 'create-issue' });
});

function createMockAdapter(applyInputs: ApplyMcpMocksInput[] = [], options: { wrappedMcpCommand?: string[]; wrappedMcpEnv?: Record<string, string> } = {}): AgentAdapter {
  return {
    name: 'mock-agent',
    async applyMcpMocks(input) {
      applyInputs.push(input);
      for (const wrapper of Object.values(input.mcpWrappers)) {
        if (options.wrappedMcpCommand) wrapper.wrappedCommand = options.wrappedMcpCommand;
        if (options.wrappedMcpEnv) wrapper.wrappedEnv = options.wrappedMcpEnv;
      }
      return { wrappedServers: Object.keys(input.mcpWrappers), unchangedServers: [] };
    },
    async prepareStep(input: AgentStepPrepareInput) {
      const config = readRecord(input.step.config);
      if (config?.mode === 'mcp') {
        const server = readString(config.server) ?? 'github';
        const wrapper = input.mocks?.mcpWrappers[server]?.wrapperCommand;
        if (!wrapper) throw new Error(`Missing MCP wrapper for ${server}`);
        return {
          argv: ['node', '-e', MCP_CALL_SCRIPT, ...wrapper, '--', readString(config.tool) ?? 'create_issue', JSON.stringify(readRecord(config.arguments) ?? {})],
          cwd: input.workspace.containerPath,
          envNames: [],
          configMounts: [],
          parser: 'text',
        };
      }
      if (config?.mode === 'mcpSequence') {
        const server = readString(config.server) ?? 'github';
        const wrapper = input.mocks?.mcpWrappers[server]?.wrapperCommand;
        if (!wrapper) throw new Error(`Missing MCP wrapper for ${server}`);
        return {
          argv: ['node', '-e', MCP_SEQUENCE_SCRIPT, ...wrapper],
          cwd: input.workspace.containerPath,
          envNames: [],
          configMounts: [],
          parser: 'text',
        };
      }

      const argv = Array.isArray(config?.argv) ? config.argv.map(String) : ['jira-cli'];
      return {
        argv,
        cwd: input.workspace.containerPath,
        envNames: [],
        configMounts: [],
        parser: 'text',
      };
    },
    async parseEvents(input) {
      return { finalOutput: input.stdout.trim(), toolCalls: [], errors: input.stderr.trim() ? [input.stderr.trim()] : [] };
    },
  };
}

async function writeHarnessProject(root: string, testCaseYaml: string, files: Record<string, string>): Promise<void> {
  await mkdir(join(root, 'cases'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'workspace', 'README.md'), 'workspace');
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
workspace:
  source: workspace
docker:
  image: fake-image
  timeoutMs: 1000
agents:
  mock:
    adapter: mock-agent
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), testCaseYaml);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function installFakeDocker(root: string): Promise<() => void> {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'docker'), FAKE_DOCKER);
  await chmod(join(binDir, 'docker'), 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = previousPath ? `${binDir}:${previousPath}` : binDir;
  return () => {
    process.env.PATH = previousPath;
  };
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, 'utf8');
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-'));
  tempDirs.push(path);
  return path;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const MCP_CALL_SCRIPT = `
const { spawn } = require('node:child_process');
const argv = process.argv.slice(1);
const separator = argv.indexOf('--');
const command = argv.slice(0, separator);
const tool = argv[separator + 1];
const args = JSON.parse(argv[separator + 2] || '{}');
const child = spawn(command[0], command.slice(1), { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.on('close', (code) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code || 0);
});
child.on('error', (error) => {
  console.error(error.message);
  process.exit(127);
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) + '\\n');
child.stdin.end();
`;

const MCP_SEQUENCE_SCRIPT = `
const { spawn } = require('node:child_process');
const argv = process.argv.slice(1);
const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const waiters = [];
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const waiter = waiters.shift();
    if (waiter) waiter(JSON.parse(line));
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => {
  console.error(error.message);
  process.exit(127);
});
function request(message) {
  return new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(JSON.stringify(message) + '\\n');
  });
}
(async () => {
  const initialize = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const tools = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const mocked = await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_issue', arguments: { title: 'checkout bug' } } });
  const realTool = await request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_repos', arguments: { org: 'acme' } } });
  const prompts = await request({ jsonrpc: '2.0', id: 5, method: 'prompts/list', params: {} });
  process.stdout.write(JSON.stringify({ initialize, tools, mocked, realTool, prompts }) + '\\n');
  child.stdin.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
`;

const REAL_MCP_SERVER = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'real-mcp', version: '1.0.0' } } });
    return;
  }
  if (request.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'list_repos', description: 'Real tool', inputSchema: { type: 'object' } }] } });
    return;
  }
  if (request.method === 'prompts/list') {
    write({ jsonrpc: '2.0', id: request.id, result: { prompts: [{ name: 'triage' }] } });
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'list_repos') {
    write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ repos: ['core'], env: process.env.REAL_MCP_VALUE }) }] } });
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'create_issue') {
    write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ number: 99 }) }] } });
    return;
  }
  write({ jsonrpc: '2.0', id: request.id, result: {} });
});
function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
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
const env = { ...process.env };
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
      const name = spec.slice(0, equals);
      const value = spec.slice(equals + 1);
      env[name] = name === 'PATH' ? mapPathList(value) + ':' + process.env.PATH : value;
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
const commandArgs = args.slice(index + 1).map(mapMaybePath);
if (!command) process.exit(0);
const result = spawnSync(mapMaybePath(command), commandArgs, {
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

function mapPathList(value) {
  return value.split(':').map(mapPath).join(':');
}

function mapMaybePath(value) {
  return value.startsWith('/') ? mapPath(value) : value;
}

function mapPath(path) {
  for (const mount of mounts) {
    if (path === mount.target || path.startsWith(mount.target + '/')) return mount.source + path.slice(mount.target.length);
  }
  return path;
}
`;
