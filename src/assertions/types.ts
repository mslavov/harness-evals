import type { AgentEventsSummary } from '../events/types.js';
import type { WorkspaceDiff } from '../workspace/diff.js';
import type { AssertionConfig } from '../config/schema.js';

export interface AssertionContext {
  output: string;
  exitCode: number | null;
  events: AgentEventsSummary;
  workspace: WorkspaceDiff;
  metadata: Record<string, unknown>;
}

export interface AssertionResult {
  type: string;
  pass: boolean;
  reason: string;
  required: boolean;
}

export type AssertionRunner = (config: AssertionConfig, context: AssertionContext) => Promise<AssertionResult> | AssertionResult;
