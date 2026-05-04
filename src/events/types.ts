import type { CostReport } from '../cost/types.js';
export type { CostReport, CostRollup, CostSummary, UsageReport } from '../cost/types.js';

export interface ToolCallSummary {
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface MockCallSummary {
  surface: 'cli' | 'mcp';
  name: string;
  args?: unknown;
  result?: unknown;
  fixture?: string;
  matched?: boolean;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentEventsSummary {
  finalOutput: string;
  toolCalls: ToolCallSummary[];
  mockCalls?: MockCallSummary[];
  errors: string[];
  cost?: CostReport;
}

export interface ParseEventsInput {
  stdout: string;
  stderr: string;
}
