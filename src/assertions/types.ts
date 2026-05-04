import type { AssertionConfig, JudgeDefaults } from '../config/schema.js';
import type { AgentEventsSummary, MockCallSummary } from '../events/types.js';
import type { JudgeRecord, JudgeRunner } from '../judge/types.js';
import type { Redaction } from '../redaction.js';
import type { WorkspaceDiff } from '../workspace/diff.js';

export interface AssertionContext {
  output: string;
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
  events: AgentEventsSummary;
  workspace: WorkspaceDiff;
  metadata: Record<string, unknown>;
  mockCalls?: MockCallSummary[];
  assertions?: AssertionResult[];
}

export interface AssertionResult {
  id?: string;
  type: string;
  pass: boolean;
  required: boolean;
  score?: number;
  threshold?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AssertionRunOptions {
  judgeDefaults?: JudgeDefaults;
  judgeRunner?: JudgeRunner;
  redactions?: readonly Redaction[];
  onJudgeRecord?: (record: JudgeRecord) => Promise<void> | void;
}

export type AssertionRunner = (config: AssertionConfig, context: AssertionContext) => Promise<AssertionResult> | AssertionResult;
