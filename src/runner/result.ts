import type { AdapterContinuation } from '../adapters/types.js';
import type { AssertionResult } from '../assertions/types.js';
import type { DockerCommandMetadata } from '../docker/runner.js';
import type { CostReport, CostSummary } from '../cost/types.js';
import type { AgentEventsSummary } from '../events/types.js';
import type { ScoreSummary } from '../scoring/types.js';
import type { HiddenPatchResult, ModelPatchArtifact, VerifierRunResult } from '../verifier/types.js';
import type { WorkspaceDiff } from '../workspace/diff.js';

export type ScenarioStepStatus = 'passed' | 'failed' | 'skipped' | 'timeout' | 'error';
export type ScenarioRunStatus = 'passed' | 'failed' | 'timeout' | 'error';

export interface ScenarioRunContext {
  scenarioId: string;
  testCaseId: string;
  agentName: string;
  runId: string;
  runDir: string;
  workspaceDir: string;
  configDir: string;
  continuation?: AdapterContinuation;
}

export interface ScenarioStepResult {
  id: string;
  originalStepId: string;
  stepIndex: number;
  status: ScenarioStepStatus;
  pass: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  stdout: string;
  stderr: string;
  command?: DockerCommandMetadata;
  events: AgentEventsSummary;
  cost: CostReport;
  assertions: AssertionResult[];
  score: ScoreSummary;
  workspace: WorkspaceDiff;
  startedAt: string;
  completedAt: string;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface TestRunResult {
  caseId: string;
  scenarioId: string;
  agentName: string;
  runId: string;
  attemptIndex: number;
  attemptNumber: number;
  attempts: number;
  status: ScenarioRunStatus;
  pass: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  runDir: string;
  steps: ScenarioStepResult[];
  assertions: AssertionResult[];
  score: ScoreSummary;
  events: AgentEventsSummary;
  cost: CostSummary;
  workspace: WorkspaceDiff;
  verifier?: VerifierRunResult;
  modelPatch?: ModelPatchArtifact;
  hiddenPatch?: HiddenPatchResult;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface HarnessRunResult {
  pass: boolean;
  results: TestRunResult[];
  cost: CostSummary;
  passAtK: PassAtKSummary[];
  outputPath: string;
}

export interface PassAtKSummary {
  caseId: string;
  scenarioId: string;
  agentName: string;
  provider?: string;
  model?: string;
  attempts: number;
  successes: number;
  eligible: boolean;
  reason?: string;
  values: Record<string, number>;
}
