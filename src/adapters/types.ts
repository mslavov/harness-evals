import type { AgentConfig, DockerConfig, TestCase, TestCaseStepDefinition, WorkspaceConfig } from '../config/schema.js';
import type { AgentEventsSummary } from '../events/types.js';

export type ResolvedAgentConfig = AgentConfig;

export interface AdapterInstallInput {
  projectRoot: string;
  agentName: string;
  agent: ResolvedAgentConfig;
  docker: DockerConfig;
}

export interface AgentStepPrepareInput {
  projectRoot: string;
  agentName: string;
  agent: ResolvedAgentConfig;
  testCase: TestCase;
  step: TestCaseStepDefinition;
  stepIndex: number;
  prompt: string;
  runDir: string;
  stepDir: string;
  workspaceDir: string;
  configDir: string;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
  mocks?: MockRuntimePlan;
  continuation?: AdapterContinuation;
}

export interface ConfigMount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface AgentStepRunPlan {
  argv: string[];
  cwd: string;
  envNames: string[];
  envValues?: Record<string, string>;
  configMounts: ConfigMount[];
  parser: string;
  metadata?: Record<string, unknown>;
  cleanupPaths?: string[];
  timeoutMs?: number;
  continuation?: AdapterContinuation;
}

export interface AdapterContinuation {
  id?: string;
  metadata?: Record<string, unknown>;
}

export interface MockRuntimePlan {
  cliPath?: string;
  envValues: Record<string, string>;
  configMounts: ConfigMount[];
  mcpWrappers: Record<string, McpMockWrapperPlan>;
  callLogPaths: string[];
  metadata: Record<string, unknown>;
}

export interface McpMockWrapperPlan {
  serverName: string;
  fixturePath: string;
  strict: boolean;
  recordPath?: string;
  wrapperCommand: string[];
  wrappedCommand?: string[];
  wrappedEnv?: Record<string, string>;
}

export interface ApplyMcpMocksInput {
  agentName: string;
  configDir: string;
  workspaceDir: string;
  mcpWrappers: Record<string, McpMockWrapperPlan>;
}

export interface ApplyMcpMocksResult {
  wrappedServers: string[];
  unchangedServers: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentEventInput {
  stdout: string;
  stderr: string;
  plan: AgentStepRunPlan;
}

export interface AdapterInstallRecipe {
  basePackages?: string[];
  commands: string[];
  probes: AdapterProbe[];
  cacheKey?: string;
}

export interface AdapterProbe {
  command: string[];
  expectedExitCode?: number;
}

export interface AgentAdapter {
  name: string;
  version?: string;
  getInstallRecipe?(input: AdapterInstallInput): Promise<AdapterInstallRecipe | undefined>;
  applyMcpMocks?(input: ApplyMcpMocksInput): Promise<ApplyMcpMocksResult>;
  prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan>;
  parseEvents(input: AgentEventInput): Promise<AgentEventsSummary>;
}


