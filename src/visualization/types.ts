import type { CostRollup, CostSummary } from '../cost/types.js';

export type VisualizationFormat = 'html' | 'json' | 'csv';
export type RunReportStatus = 'passed' | 'failed' | 'error' | 'incomplete';

export interface RunReport {
  runId: string;
  status: RunReportStatus;
  startedAt?: string;
  completedAt?: string;
  summary: RunReportSummary;
  columns: AgentReportColumn[];
  rows: TestCaseReportRow[];
}

export interface RunReportSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  score?: number;
  durationMs?: number;
  cost?: CostSummary;
  tokenUsage?: CostRollup;
  passAtK?: unknown[];
}

export interface AgentReportColumn {
  key: string;
  agentName: string;
  label?: string;
  adapter?: string;
  provider?: string;
  model?: string;
}

export interface TestCaseReportRow {
  testCaseId: string;
  suite?: string;
  description?: string;
  cells: Record<string, TestCaseAgentReportCell>;
}

export interface TestCaseAgentReportCell {
  status: 'passed' | 'failed' | 'error' | 'skipped' | 'incomplete';
  score?: number;
  durationMs?: number;
  cost?: CostSummary;
  tokenUsage?: CostRollup;
  assertionSummary: { total: number; passed: number; failed: number; requiredFailed: number };
  stepSummary: { total: number; passed: number; failed: number; skipped: number; errors: number };
  runDir?: string;
  details: TestCaseAgentDetails;
}

export interface TestCaseAgentDetails {
  steps: unknown[];
  workspaceDiff?: unknown;
  toolCalls?: unknown[];
  mockCalls?: unknown[];
  judgeResults?: unknown[];
  logs?: ReportLogRef[];
  artifacts?: ReportArtifactRef[];
  assertions?: unknown[];
  verifier?: unknown;
  error?: string;
}

export interface ReportLogRef {
  label: string;
  href: string;
}

export interface ReportArtifactRef {
  label: string;
  href: string;
}
