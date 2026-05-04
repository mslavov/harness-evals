import type { CostSummary } from '../cost/types.js';
import type { AgentReportColumn, RunReport, RunReportStatus, TestCaseAgentReportCell, TestCaseReportRow } from './types.js';

export interface ReportIncludeConfig {
  logs: boolean;
  workspaceDiff: boolean;
  toolCalls: boolean;
  mockCalls: boolean;
  judgeDetails: boolean;
}

export interface BuildRunReportOptions {
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  include?: Partial<ReportIncludeConfig>;
}

const DEFAULT_REPORT_INCLUDE: ReportIncludeConfig = {
  logs: true,
  workspaceDiff: true,
  toolCalls: true,
  mockCalls: true,
  judgeDetails: true,
};

export function buildRunReport(source: unknown, options: BuildRunReportOptions = {}): RunReport {
  const payload = record(source);
  const results = readResults(payload);
  const runId = options.runId ?? stringValue(payload.runId) ?? firstString(results, 'runId') ?? 'latest';
  const include = { ...DEFAULT_REPORT_INCLUDE, ...(options.include ?? {}) };
  const columns = buildColumns(results);
  const rows = buildRows(results, columns, include);
  const statuses = results.map(resultStatus);
  const passed = statuses.filter((status) => status === 'passed').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const errors = statuses.filter((status) => status === 'error').length;
  const skipped = statuses.filter((status) => status === 'skipped').length;
  const scores = results.map((result) => scoreValue(result.score)).filter((score): score is number => score !== undefined);
  const durationMs = sumDefined(results.map((result) => numberValue(result.durationMs)));
  const cost = readCostSummary(payload.cost) ?? readCostSummary(firstRecordWith(results, 'cost')?.cost);

  return {
    runId,
    status: reportStatus(statuses, payload.pass),
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    summary: {
      total: results.length,
      passed,
      failed,
      errors,
      skipped,
      score: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : undefined,
      durationMs,
      cost,
      tokenUsage: cost?.rollup,
    },
    columns,
    rows,
  };
}

function readResults(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload.results)) return payload.results.filter(isRecord);
  if (stringValue(payload.caseId) || stringValue(payload.agentName)) return [payload];
  return [];
}

function buildColumns(results: Record<string, unknown>[]): AgentReportColumn[] {
  const columns = new Map<string, AgentReportColumn>();
  for (const result of results) {
    const agentName = stringValue(result.agentName) ?? 'agent';
    const provider = readProvider(result);
    const model = readModel(result);
    const key = columnKey(agentName, provider, model);
    if (!columns.has(key)) {
      columns.set(key, {
        key,
        agentName,
        label: stringValue(result.label),
        adapter: stringValue(result.adapter),
        provider,
        model,
      });
    }
  }
  return [...columns.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function buildRows(results: Record<string, unknown>[], columns: AgentReportColumn[], include: ReportIncludeConfig): TestCaseReportRow[] {
  const rows = new Map<string, TestCaseReportRow>();
  for (const result of results) {
    const testCaseId = stringValue(result.caseId) ?? stringValue(result.scenarioId) ?? 'case';
    const column = columns.find((candidate) => candidate.key === columnKey(stringValue(result.agentName) ?? 'agent', readProvider(result), readModel(result)));
    if (!column) continue;
    const existing = rows.get(testCaseId) ?? { testCaseId, suite: readSuite(result), description: readDescription(result), cells: {} };
    existing.cells[column.key] = buildCell(result, include);
    rows.set(testCaseId, existing);
  }
  return [...rows.values()].sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));
}

function buildCell(result: Record<string, unknown>, include: ReportIncludeConfig): TestCaseAgentReportCell {
  const assertions = Array.isArray(result.assertions) ? result.assertions.filter(isRecord) : [];
  const steps = Array.isArray(result.steps) ? result.steps.filter(isRecord) : [];
  const cost = readCostSummary(result.cost);
  const workspace = result.workspace ?? record(result.metadata).workspace;
  const toolCalls = arrayFrom(record(result.events).toolCalls).concat(steps.flatMap((step) => arrayFrom(record(step.events).toolCalls)));
  const mockCalls = arrayFrom(record(result.events).mockCalls).concat(arrayFrom(record(record(result.metadata).mockCalls).summary));
  const judgeResults = assertions.filter((assertion) => assertion.type === 'llmJudge' || assertion.judge !== undefined || assertion.rationale !== undefined);

  return {
    status: resultStatus(result),
    score: scoreValue(result.score),
    durationMs: numberValue(result.durationMs),
    cost,
    tokenUsage: cost?.rollup,
    assertionSummary: summarizeAssertions(assertions, result.assertions),
    stepSummary: summarizeSteps(steps),
    runDir: stringValue(result.runDir),
    details: {
      steps,
      workspaceDiff: include.workspaceDiff ? workspace : undefined,
      toolCalls: include.toolCalls ? toolCalls : undefined,
      mockCalls: include.mockCalls ? mockCalls : undefined,
      judgeResults: include.judgeDetails ? judgeResults : undefined,
      assertions,
      error: stringValue(result.error),
      logs: include.logs ? logRefs(steps) : undefined,
      artifacts: artifactRefs(result),
    },
  };
}

function summarizeAssertions(assertions: Record<string, unknown>[], fallback: unknown): TestCaseAgentReportCell['assertionSummary'] {
  if (assertions.length === 0 && isRecord(fallback)) {
    const total = numberValue(fallback.total) ?? 0;
    const requiredFailed = numberValue(fallback.failedRequired) ?? numberValue(fallback.requiredFailed) ?? 0;
    const passed = numberValue(fallback.passed) ?? Math.max(0, total - requiredFailed);
    return { total, passed, failed: Math.max(0, total - passed), requiredFailed };
  }
  const requiredFailed = assertions.filter((assertion) => assertion.pass !== true && assertion.required !== false).length;
  const passed = assertions.filter((assertion) => assertion.pass === true || assertion.required === false).length;
  return { total: assertions.length, passed, failed: assertions.length - passed, requiredFailed };
}

function summarizeSteps(steps: Record<string, unknown>[]): TestCaseAgentReportCell['stepSummary'] {
  return {
    total: steps.length,
    passed: steps.filter((step) => step.pass === true || step.status === 'passed').length,
    failed: steps.filter((step) => step.status === 'failed' || (step.pass === false && step.status !== 'error' && step.status !== 'skipped')).length,
    skipped: steps.filter((step) => step.status === 'skipped').length,
    errors: steps.filter((step) => step.status === 'error' || step.status === 'timeout').length,
  };
}

function resultStatus(result: Record<string, unknown>): TestCaseAgentReportCell['status'] {
  const status = stringValue(result.status);
  if (status === 'passed' || status === 'failed' || status === 'error' || status === 'skipped' || status === 'incomplete') return status;
  if (result.pass === true) return 'passed';
  if (result.pass === false) return 'failed';
  return 'incomplete';
}

function reportStatus(statuses: string[], pass: unknown): RunReportStatus {
  if (statuses.some((status) => status === 'error')) return 'error';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.length === 0) return 'incomplete';
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (pass === true) return 'passed';
  if (pass === false) return 'failed';
  return 'incomplete';
}

function readProvider(result: Record<string, unknown>): string | undefined {
  const cost = readCostSummary(result.cost);
  const provider = Object.keys(cost?.byProvider ?? {})[0];
  return provider || stringValue(record(result.metadata).provider);
}

function readModel(result: Record<string, unknown>): string | undefined {
  const cost = readCostSummary(result.cost);
  const model = Object.keys(cost?.byModel ?? {})[0];
  return model || stringValue(record(result.metadata).model);
}

function columnKey(agentName: string, provider?: string, model?: string): string {
  return [agentName, provider, model].filter(Boolean).join('|');
}

function readCostSummary(value: unknown): CostSummary | undefined {
  if (!isRecord(value) || typeof value.available !== 'boolean' || !isRecord(value.rollup)) return undefined;
  return value as unknown as CostSummary;
}

function scoreValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (isRecord(value)) return numberValue(value.score);
  return undefined;
}

function logRefs(steps: Record<string, unknown>[]) {
  return steps.flatMap((step) => {
    const id = stringValue(step.id) ?? stringValue(step.stepId);
    if (!id) return [];
    return [
      { label: `${id} stdout`, href: `steps/${safePath(id)}/stdout.log` },
      { label: `${id} stderr`, href: `steps/${safePath(id)}/stderr.log` },
    ];
  });
}

function artifactRefs(result: Record<string, unknown>) {
  const refs = [];
  if (stringValue(result.runDir)) refs.push({ label: 'run directory', href: stringValue(result.runDir)! });
  if (result.workspace) refs.push({ label: 'workspace diff', href: 'workspace-diff.json' });
  return refs;
}

function readSuite(result: Record<string, unknown>): string | undefined {
  return stringValue(result.suite) ?? stringValue(record(record(result.metadata).testCase).suite);
}

function readDescription(result: Record<string, unknown>): string | undefined {
  return stringValue(result.description) ?? stringValue(record(record(result.metadata).testCase).description);
}

function firstString(records: Record<string, unknown>[], key: string): string | undefined {
  return records.map((value) => stringValue(value[key])).find(Boolean);
}

function firstRecordWith(records: Record<string, unknown>[], key: string): Record<string, unknown> | undefined {
  return records.find((value) => value[key] !== undefined);
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safePath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'step';
}
