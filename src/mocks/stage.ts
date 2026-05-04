import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { toContainerPath } from '../config/paths.js';
import type { AgentAdapter, McpMockWrapperPlan, MockRuntimePlan } from '../adapters/types.js';
import type { MockConfig, TestCaseMockConfig } from '../config/schema.js';
import { loadMockFixture, resolveMockFixturePath } from './fixtures.js';
import type { MergedMockDeclarations, MockFixture, StagedMockRuntimePlan, StagedMockSurfaceMetadata } from './types.js';

export interface StageMockRuntimeInput {
  projectRoot: string;
  defaults: MockConfig;
  testCaseMocks?: TestCaseMockConfig;
  stepMocks?: TestCaseMockConfig;
  adapter: AgentAdapter;
  agentName: string;
  agentAdapterName: string;
  testCaseId: string;
  configDir: string;
  configTarget: string;
  workspaceDir: string;
  stepId: string;
}

const DEFAULT_CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function mergeMockDeclarations(
  defaults: MockConfig,
  testCaseMocks?: TestCaseMockConfig,
  stepMocks?: TestCaseMockConfig,
): MergedMockDeclarations | undefined {
  const cli = { ...(testCaseMocks?.cli ?? {}), ...(stepMocks?.cli ?? {}) };
  const mcp = { ...(testCaseMocks?.mcp ?? {}), ...(stepMocks?.mcp ?? {}) };
  if (Object.keys(cli).length === 0 && Object.keys(mcp).length === 0) return undefined;

  return {
    cli,
    mcp,
    strict: stepMocks?.strict ?? testCaseMocks?.strict ?? defaults.strict,
    recordCalls: defaults.recordCalls,
  };
}

export async function stageMockRuntime(input: StageMockRuntimeInput): Promise<StagedMockRuntimePlan | undefined> {
  const declarations = mergeMockDeclarations(input.defaults, input.testCaseMocks, input.stepMocks);
  if (!declarations) return undefined;
  if (Object.keys(declarations.mcp).length > 0 && !input.adapter.applyMcpMocks) {
    throw new Error(`MCP mocks are declared for ${input.testCaseId}, but adapter ${input.agentAdapterName} does not support applyMcpMocks`);
  }

  const hostBaseDir = join(input.configDir, 'mocks');
  const hostCliDir = join(hostBaseDir, 'cli', input.stepId);
  const hostCallsDir = join(hostBaseDir, 'calls', input.stepId);
  const hostPlansDir = join(hostBaseDir, 'plans', input.stepId);
  const hostBinDir = join(hostBaseDir, 'bin');
  const containerCliDir = toContainerPath(input.configTarget, `mocks/cli/${input.stepId}`);
  const containerPlansDir = toContainerPath(input.configTarget, `mocks/plans/${input.stepId}`);
  const containerCallsDir = toContainerPath(input.configTarget, `mocks/calls/${input.stepId}`);
  const containerBinDir = toContainerPath(input.configTarget, 'mocks/bin');
  const cliMetadata: Record<string, StagedMockSurfaceMetadata> = {};
  const mcpMetadata: Record<string, StagedMockSurfaceMetadata> = {};
  const mcpWrappers: Record<string, McpMockWrapperPlan> = {};
  const mcpFixtures: Record<string, MockFixture> = {};
  const mcpPlanHostPaths: Record<string, string> = {};
  const callLogPaths: string[] = [];

  if (Object.keys(declarations.cli).length > 0) {
    await mkdir(hostCliDir, { recursive: true });
    await mkdir(hostPlansDir, { recursive: true });
    await mkdir(hostCallsDir, { recursive: true });

    for (const [command, fixtureRef] of Object.entries(declarations.cli)) {
      assertExecutableName(command, `mocks.cli.${command}`);
      const fixture = await loadDeclaredFixture(input, 'cli', command, fixtureRef);
      const safeCommand = safePathPart(command);
      const wrapperPath = join(hostCliDir, command);
      const planPath = join(hostCliDir, `${safeCommand}.json`);
      const callLogPath = declarations.recordCalls ? join(hostCallsDir, `cli-${safeCommand}.jsonl`) : undefined;
      const recordFile = callLogPath ? `cli-${safeCommand}.jsonl` : undefined;

      await writeJson(planPath, {
        surface: 'cli',
        command,
        fixtureName: fixture.name,
        fixturePath: fixture.sourcePath,
        strict: declarations.strict,
        recordCalls: declarations.recordCalls,
        recordFile,
        rules: fixture.mocks,
      });
      await writeFile(wrapperPath, buildCliWrapperScript(`${safeCommand}.json`));
      await chmod(wrapperPath, 0o755);

      if (callLogPath) callLogPaths.push(callLogPath);
      cliMetadata[command] = {
        fixture: fixtureRef,
        fixturePath: fixture.sourcePath,
        callLogPath,
        wrapperPath,
        planPath,
      };
    }
  }

  if (Object.keys(declarations.mcp).length > 0) {
    await mkdir(hostBinDir, { recursive: true });
    await mkdir(hostPlansDir, { recursive: true });
    await mkdir(hostCallsDir, { recursive: true });
    const wrapperHostPath = join(hostBinDir, 'mcp-wrapper.cjs');
    const wrapperContainerPath = toContainerPath(input.configTarget, 'mocks/bin/mcp-wrapper.cjs');
    await writeFile(wrapperHostPath, MCP_WRAPPER_SCRIPT);
    await chmod(wrapperHostPath, 0o755);

    for (const [serverName, fixtureRef] of Object.entries(declarations.mcp)) {
      const fixture = await loadDeclaredFixture(input, 'mcp', serverName, fixtureRef);
      const safeServer = safePathPart(serverName);
      const planHostPath = join(hostPlansDir, `mcp-${safeServer}.json`);
      const planContainerPath = `${containerPlansDir}/mcp-${safeServer}.json`;
      const callLogPath = declarations.recordCalls ? join(hostCallsDir, `mcp-${safeServer}.jsonl`) : undefined;
      const recordPath = declarations.recordCalls ? `${containerCallsDir}/mcp-${safeServer}.jsonl` : undefined;
      const recordFile = declarations.recordCalls ? `mcp-${safeServer}.jsonl` : undefined;

      const wrapperPlan: McpMockWrapperPlan = {
        serverName,
        fixturePath: fixture.sourcePath,
        strict: declarations.strict,
        recordPath,
        wrapperCommand: ['node', wrapperContainerPath, planContainerPath],
      };
      await writeMcpPlan(planHostPath, serverName, fixture, declarations.strict, declarations.recordCalls, recordFile, wrapperPlan);

      if (callLogPath) callLogPaths.push(callLogPath);
      mcpWrappers[serverName] = wrapperPlan;
      mcpFixtures[serverName] = fixture;
      mcpPlanHostPaths[serverName] = planHostPath;
      mcpMetadata[serverName] = {
        fixture: fixtureRef,
        fixturePath: fixture.sourcePath,
        callLogPath,
        wrapperPath: wrapperHostPath,
        planPath: planHostPath,
      };
    }
  }

  let applyMcpMocks: unknown;
  if (Object.keys(mcpWrappers).length > 0 && input.adapter.applyMcpMocks) {
    applyMcpMocks = await input.adapter.applyMcpMocks({
      agentName: input.agentName,
      configDir: input.configDir,
      workspaceDir: input.workspaceDir,
      mcpWrappers,
    });
    for (const [serverName, wrapperPlan] of Object.entries(mcpWrappers)) {
      const fixture = mcpFixtures[serverName];
      const planHostPath = mcpPlanHostPaths[serverName];
      if (fixture && planHostPath) await writeMcpPlan(planHostPath, serverName, fixture, declarations.strict, declarations.recordCalls, wrapperPlan.recordPath ? basename(wrapperPlan.recordPath) : undefined, wrapperPlan);
    }
  }

  const envValues: Record<string, string> = {};
  if (Object.keys(declarations.cli).length > 0) {
    envValues.PATH = `${containerCliDir}:${DEFAULT_CONTAINER_PATH}`;
    envValues.HARNESS_EVALS_MOCK_CLI_DIR = containerCliDir;
  }

  return {
    cliPath: Object.keys(declarations.cli).length > 0 ? containerCliDir : undefined,
    envValues,
    configMounts: [],
    mcpWrappers,
    callLogPaths,
    metadata: {
      mocks: {
        strict: declarations.strict,
        recordCalls: declarations.recordCalls,
        cli: Object.keys(cliMetadata).length > 0 ? cliMetadata : undefined,
        mcp: Object.keys(mcpMetadata).length > 0 ? mcpMetadata : undefined,
        applyMcpMocks,
      },
    },
  };
}

export function applyMockRuntimeToPlan(plan: { envValues?: Record<string, string>; configMounts: MockRuntimePlan['configMounts']; metadata?: Record<string, unknown> }, mocks: MockRuntimePlan | undefined): void {
  if (!mocks) return;
  const envValues = { ...(plan.envValues ?? {}) };
  for (const [name, value] of Object.entries(mocks.envValues)) {
    if (name === 'PATH' && envValues.PATH) envValues.PATH = `${readCliPath(mocks) ?? value}:${envValues.PATH}`;
    else if (envValues[name] === undefined) envValues[name] = value;
  }
  plan.envValues = envValues;
  plan.configMounts = [...mocks.configMounts, ...plan.configMounts];
  plan.metadata = { ...(plan.metadata ?? {}), ...mocks.metadata };
}

export function buildMockConfigPayload(input: {
  declarations: MergedMockDeclarations;
  testCaseMocks?: TestCaseMockConfig;
  stepMocks?: TestCaseMockConfig;
  runtime: MockRuntimePlan;
}): Record<string, unknown> {
  return {
    strict: input.declarations.strict,
    recordCalls: input.declarations.recordCalls,
    cli: input.declarations.cli,
    mcp: input.declarations.mcp,
    testCase: input.testCaseMocks,
    step: input.stepMocks,
    runtime: input.runtime.metadata,
    callLogPaths: input.runtime.callLogPaths,
  };
}

async function loadDeclaredFixture(
  input: StageMockRuntimeInput,
  surface: 'cli' | 'mcp',
  name: string,
  fixtureRef: string,
): Promise<MockFixture> {
  const fixturePath = resolveMockFixturePath(input.defaults.root, input.projectRoot, surface, fixtureRef, `mocks.${surface}.${name}`);
  return loadMockFixture(fixturePath);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMcpPlan(
  path: string,
  serverName: string,
  fixture: MockFixture,
  strict: boolean,
  recordCalls: boolean,
  recordFile: string | undefined,
  wrapperPlan: McpMockWrapperPlan,
): Promise<void> {
  await writeJson(path, {
    surface: 'mcp',
    serverName,
    fixtureName: fixture.name,
    fixturePath: fixture.sourcePath,
    strict,
    recordCalls,
    recordFile,
    rules: fixture.mocks,
    wrappedCommand: wrapperPlan.wrappedCommand,
    wrappedEnv: wrapperPlan.wrappedEnv,
  });
}

function readCliPath(mocks: MockRuntimePlan): string | undefined {
  return typeof mocks.cliPath === 'string' ? mocks.cliPath : undefined;
}

function assertExecutableName(value: string, field: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`${field} must be an executable name, not a path`);
  }
}

function safePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'mock';
}

function buildCliWrapperScript(planFileName: string): string {
  return `#!/usr/bin/env node
${CLI_WRAPPER_SCRIPT.replace('__PLAN_FILE__', JSON.stringify(planFileName))}`;
}

const CLI_WRAPPER_SCRIPT = String.raw`
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const plan = JSON.parse(readFileSync(path.join(__dirname, __PLAN_FILE__), 'utf8'));

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.exit(1);
});

async function main() {
  const argv = process.argv.slice(2);
  const input = parseCliInput(argv);
  const match = findMatchingRule(plan.rules, input.toolCandidates, input.matchInput);
  const call = {
    surface: 'cli',
    command: plan.command,
    tool: match ? match.rule.tool : input.toolCandidates[0],
    input: input.matchInput,
    matched: Boolean(match),
    strict: Boolean(plan.strict),
    fixtureName: plan.fixtureName,
    fixturePath: plan.fixturePath,
    ruleId: match && match.rule.id,
    timestamp: new Date().toISOString(),
  };

  if (match && typeof match.rule.delayMs === 'number' && match.rule.delayMs > 0) await sleep(match.rule.delayMs);

  if (!match) {
    const message = 'Unmatched CLI mock call: ' + input.toolCandidates[0];
    call.error = message;
    call.exitCode = plan.strict ? 1 : 0;
    recordCall(call);
    if (plan.strict) process.stderr.write(message + '\n');
    process.exit(call.exitCode);
  }

  const exitCode = typeof match.rule.exitCode === 'number' ? match.rule.exitCode : 0;
  const stdout = typeof match.rule.stdout === 'string'
    ? match.rule.stdout
    : Object.prototype.hasOwnProperty.call(match.rule, 'response')
      ? JSON.stringify(match.rule.response)
      : '';
  const stderr = typeof match.rule.stderr === 'string' ? match.rule.stderr : '';

  call.exitCode = exitCode;
  recordCall(call);
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n');
  if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : stderr + '\n');
  process.exit(exitCode);
}

function parseCliInput(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals !== -1) {
        flags[arg.slice(2, equals)] = arg.slice(equals + 1);
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[arg.slice(2)] = next;
          index += 1;
        } else {
          flags[arg.slice(2)] = 'true';
        }
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.replace(/^-+/, '');
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = 'true';
      }
      continue;
    }
    positional.push(arg);
  }

  const subcommand = positional[0];
  const matchInput = {
    ...flags,
    command: plan.command,
    subcommand: subcommand || '',
    args: argv.join(' '),
    positional: positional.join(' '),
  };
  const toolCandidates = subcommand ? [plan.command + ':' + subcommand, plan.command] : [plan.command];
  return { toolCandidates, matchInput };
}

function findMatchingRule(rules, toolCandidates, input) {
  for (const rule of rules) {
    if (!toolCandidates.includes(rule.tool)) continue;
    if (!matchesInput(rule.match, input)) continue;
    return { rule };
  }
  return undefined;
}

function matchesInput(match, input) {
  if (!match) return true;
  return Object.entries(match).every(([key, pattern]) => simpleGlobMatch(String(pattern), String(input[key] ?? '')));
}

function simpleGlobMatch(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value === pattern;
  const parts = pattern.split('*');
  let offset = 0;
  if (!pattern.startsWith('*')) {
    const first = parts.shift();
    if (!value.startsWith(first)) return false;
    offset = first.length;
  }
  if (!pattern.endsWith('*')) {
    const last = parts.pop();
    if (!value.endsWith(last)) return false;
  }
  for (const part of parts) {
    if (!part) continue;
    const found = value.indexOf(part, offset);
    if (found === -1) return false;
    offset = found + part.length;
  }
  return true;
}

function recordCall(call) {
  if (!plan.recordCalls || !plan.recordFile) return;
  const recordPath = path.resolve(__dirname, '..', '..', 'calls', path.basename(__dirname), plan.recordFile);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  appendFileSync(recordPath, JSON.stringify(call) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`;

const MCP_WRAPPER_SCRIPT = String.raw`#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { appendFileSync, mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const planPath = process.argv[2];
if (!planPath) {
  process.stderr.write('MCP mock wrapper requires a plan path\n');
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const realServer = startRealServer(readWrappedCommand(process.argv.slice(3)));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  handleLine(line).catch((error) => {
    const id = readRequestId(line);
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: error && error.message ? error.message : String(error) } });
  });
});

rl.on('close', () => {
  if (realServer) realServer.child.stdin.end();
});

async function handleLine(line) {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === 'tools/call') {
    await handleToolCall(request);
    return;
  }
  if (realServer) {
    const response = await forwardToRealServer(request);
    if (response) write(response);
    return;
  }
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'harness-evals-mcp-mock', version: '0.1.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    const names = [...new Set(plan.rules.map((rule) => rule.tool))];
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: names.map((name) => ({ name, description: 'Mocked tool', inputSchema: { type: 'object' } })) },
    });
    return;
  }
  write({ jsonrpc: '2.0', id: request.id, result: {} });
}

async function handleToolCall(request) {
  const toolName = request && request.params && request.params.name ? String(request.params.name) : '';
  const input = normalizeInput(request && request.params ? request.params.arguments : undefined);
  const rule = findMatchingRule(plan.rules, toolName, input);
  const call = {
    surface: 'mcp',
    serverName: plan.serverName,
    tool: toolName,
    input,
    matched: Boolean(rule),
    strict: Boolean(plan.strict),
    fixtureName: plan.fixtureName,
    fixturePath: plan.fixturePath,
    ruleId: rule && rule.id,
    timestamp: new Date().toISOString(),
  };

  if (rule && typeof rule.delayMs === 'number' && rule.delayMs > 0) await sleep(rule.delayMs);

  if (!rule) {
    const knownMockedTool = hasRulesForTool(plan.rules, toolName);
    if (realServer && !knownMockedTool) {
      const response = await forwardToRealServer(request);
      if (response) write(response);
      return;
    }

    if (realServer && !plan.strict) {
      recordCall(call);
      const response = await forwardToRealServer(request);
      if (response) write(response);
      return;
    }

    const message = 'Unmatched MCP mock call: ' + toolName;
    call.error = message;
    recordCall(call);
    if (plan.strict) {
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message } });
    } else {
      write({ jsonrpc: '2.0', id: request.id, result: { content: [] } });
    }
    return;
  }

  recordCall(call);
  const text = Object.prototype.hasOwnProperty.call(rule, 'response') ? JSON.stringify(rule.response) : '';
  write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text }] } });
}

function findMatchingRule(rules, toolName, input) {
  for (const rule of rules) {
    if (rule.tool !== toolName) continue;
    if (!matchesInput(rule.match, input)) continue;
    return rule;
  }
  return undefined;
}

function hasRulesForTool(rules, toolName) {
  return rules.some((rule) => rule.tool === toolName);
}

function matchesInput(match, input) {
  if (!match) return true;
  return Object.entries(match).every(([key, pattern]) => simpleGlobMatch(String(pattern), String(input[key] ?? '')));
}

function simpleGlobMatch(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value === pattern;
  const parts = pattern.split('*');
  let offset = 0;
  if (!pattern.startsWith('*')) {
    const first = parts.shift();
    if (!value.startsWith(first)) return false;
    offset = first.length;
  }
  if (!pattern.endsWith('*')) {
    const last = parts.pop();
    if (!value.endsWith(last)) return false;
  }
  for (const part of parts) {
    if (!part) continue;
    const found = value.indexOf(part, offset);
    if (found === -1) return false;
    offset = found + part.length;
  }
  return true;
}

function normalizeInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function recordCall(call) {
  if (!plan.recordCalls || !plan.recordFile) return;
  const recordPath = path.resolve(path.dirname(planPath), '..', '..', 'calls', path.basename(path.dirname(planPath)), plan.recordFile);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  appendFileSync(recordPath, JSON.stringify(call) + '\n');
}

function readWrappedCommand(extraArgs) {
  if (Array.isArray(plan.wrappedCommand) && plan.wrappedCommand.length > 0) return plan.wrappedCommand.map(String);
  const separator = extraArgs.findIndex((arg) => arg === '--' || arg === '--wrap');
  return separator === -1 ? [] : extraArgs.slice(separator + 1);
}

function startRealServer(command) {
  if (command.length === 0) return undefined;
  const child = spawn(command[0], command.slice(1), {
    env: { ...process.env, ...readWrappedEnv() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  stdout.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(line + '\n');
      return;
    }
    const key = responseKey(message);
    const waiter = key === undefined ? undefined : pending.get(key);
    if (!waiter) {
      write(message);
      return;
    }
    pending.delete(key);
    waiter.resolve(message);
  });

  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('error', (error) => rejectPending(pending, error));
  child.on('close', (code) => rejectPending(pending, new Error('Wrapped MCP server exited with code ' + code)));
  return { child, pending };
}

function forwardToRealServer(request) {
  if (!realServer) return Promise.resolve(undefined);
  const key = requestKey(request);
  realServer.child.stdin.write(JSON.stringify(request) + '\n');
  if (key === undefined) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    realServer.pending.set(key, { resolve, reject });
  });
}

function readWrappedEnv() {
  if (!plan.wrappedEnv || typeof plan.wrappedEnv !== 'object' || Array.isArray(plan.wrappedEnv)) return {};
  return Object.fromEntries(Object.entries(plan.wrappedEnv).map(([key, value]) => [key, String(value)]));
}

function requestKey(request) {
  if (!request || !Object.prototype.hasOwnProperty.call(request, 'id')) return undefined;
  return JSON.stringify(request.id);
}

function responseKey(response) {
  if (!response || !Object.prototype.hasOwnProperty.call(response, 'id')) return undefined;
  return JSON.stringify(response.id);
}

function rejectPending(pending, error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function readRequestId(line) {
  try {
    return JSON.parse(line).id;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`;
