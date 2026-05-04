import type { AgentConfig, DockerConfig, TestCase, WorkspaceConfig } from '../config/schema.js';
import type { AgentEventsSummary } from '../events/types.js';

export interface AgentPrepareInput {
  projectRoot: string;
  agentName: string;
  agent: AgentConfig;
  testCase: TestCase;
  prompt: string;
  runDir: string;
  workspaceDir: string;
  configDir: string;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
}

export interface ConfigMount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface AgentRunPlan {
  argv: string[];
  cwd: string;
  envNames: string[];
  envValues?: Record<string, string>;
  configMounts: ConfigMount[];
  parser: string;
  metadata?: Record<string, unknown>;
  cleanupPaths?: string[];
  timeoutMs?: number;
}

export interface AgentEventInput {
  stdout: string;
  stderr: string;
  plan: AgentRunPlan;
}

export interface AgentAdapter {
  name: string;
  prepareRun(input: AgentPrepareInput): Promise<AgentRunPlan>;
  parseEvents(input: AgentEventInput): Promise<AgentEventsSummary>;
}

export function defineAdapter(adapter: AgentAdapter): AgentAdapter {
  return adapter;
}
