import type { AssertionResult } from '../assertions/types.js';
import type { AgentEventsSummary } from '../events/types.js';
import type { WorkspaceDiff } from '../workspace/diff.js';

export interface TestRunResult {
  caseId: string;
  agentName: string;
  pass: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  runDir: string;
  assertions: AssertionResult[];
  events: AgentEventsSummary;
  workspace: WorkspaceDiff;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface HarnessRunResult {
  pass: boolean;
  results: TestRunResult[];
  outputPath: string;
}
