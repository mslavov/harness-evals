import type { AggregateReportData, AggregateTaskRun } from './data.js';

const CSV_COLUMNS = [
  'batchId', 'caseId', 'suite', 'agentName', 'provider', 'models', 'attemptNumber', 'status', 'pass',
  'score', 'durationMs', 'cost', 'currency', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'requests',
  'startedAt', 'runId',
] as const;

export function renderAggregateCsv(runs: readonly AggregateTaskRun[]): string {
  const rows = runs.map((run) => [
    run.batchId,
    run.caseId,
    run.suite ?? '',
    run.agentName,
    run.provider ?? '',
    (run.models ?? []).join('+'),
    run.attemptNumber ?? '',
    run.status,
    run.pass,
    run.score ?? '',
    run.durationMs ?? '',
    run.cost?.totalCost ?? '',
    run.cost?.currency ?? '',
    run.cost?.inputTokens ?? '',
    run.cost?.cachedInputTokens ?? '',
    run.cost?.outputTokens ?? '',
    run.cost?.totalTokens ?? '',
    run.cost?.requests ?? '',
    run.startedAt ?? '',
    run.runId,
  ].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

export function renderAggregateJson(data: AggregateReportData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
