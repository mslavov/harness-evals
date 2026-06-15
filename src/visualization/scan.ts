import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Workspace run scanner: enumerates task-run directories under the artifact
 * root and produces compact records for aggregate reporting. Reads ONLY
 * summary.json and run-started.json — legacy result.json files can be hundreds
 * of megabytes (pre-streaming-fix runs embedded full agent stdout).
 */

export type ScannedRunStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'timeout' | 'incomplete';

export interface ScannedTaskRun {
  runId: string;
  runDir: string;
  batchId: string;
  batchSynthetic: boolean;
  caseId: string;
  agentName: string;
  suite?: string;
  description?: string;
  attemptNumber?: number;
  attempts?: number;
  status: ScannedRunStatus;
  pass: boolean;
  startedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  error?: string;
  score?: number;
  cost?: {
    totalCost?: number;
    currency?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    requests?: number;
  };
  provider?: string;
  model?: string;
  models?: string[];
  assertions?: { total: number; passed: number; failedRequired: number };
  hasIndexHtml: boolean;
}

export interface BatchSummaryInfo {
  batchId: string;
  startedAt?: string;
  label?: string;
  argv?: string[];
  agents?: string[];
  synthetic: boolean;
  runCount: number;
}

export interface WorkspaceScanResult {
  taskRuns: ScannedTaskRun[];
  batches: BatchSummaryInfo[];
  warnings: string[];
}

export interface CaseInfoMap {
  [caseId: string]: { suite?: string; description?: string };
}

export interface TaskRunFilters {
  batchIds?: string[];
  agents?: string[];
  suites?: string[];
  cases?: string[];
  statuses?: string[];
}

const SCAN_CONCURRENCY = 16;
const DIR_TIMESTAMP_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-\d+$/;

export async function scanWorkspaceRuns(options: { artifactRoot: string; caseInfo?: CaseInfoMap }): Promise<WorkspaceScanResult> {
  const warnings: string[] = [];
  let entries: string[] = [];
  try {
    const dirents = await readdir(options.artifactRoot, { withFileTypes: true });
    entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return { taskRuns: [], batches: [], warnings: [`Artifact root not found: ${options.artifactRoot}`] };
  }

  const taskRuns: ScannedTaskRun[] = [];
  const batchMeta = new Map<string, BatchSummaryInfo>();
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, queue.length) }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const scanned = await scanRunDir(join(options.artifactRoot, name), name, options.caseInfo, warnings, batchMeta);
      if (scanned) taskRuns.push(scanned);
    }
  });
  await Promise.all(workers);

  const counts = new Map<string, number>();
  for (const run of taskRuns) counts.set(run.batchId, (counts.get(run.batchId) ?? 0) + 1);
  const batches: BatchSummaryInfo[] = [...counts.entries()].map(([batchId, runCount]) => {
    const meta = batchMeta.get(batchId);
    return {
      batchId,
      startedAt: meta?.startedAt,
      label: meta?.label,
      argv: meta?.argv,
      agents: meta?.agents,
      synthetic: meta?.synthetic ?? batchId.startsWith('legacy-'),
      runCount,
    };
  });
  batches.sort((a, b) => batchSortKey(b).localeCompare(batchSortKey(a)));
  taskRuns.sort((a, b) => (sortStamp(b) > sortStamp(a) ? 1 : sortStamp(b) < sortStamp(a) ? -1 : 0));

  return { taskRuns, batches, warnings };
}

export function filterTaskRuns(runs: readonly ScannedTaskRun[], filters: TaskRunFilters): ScannedTaskRun[] {
  const batchIds = filters.batchIds?.length ? new Set(filters.batchIds) : undefined;
  const agents = filters.agents?.length ? new Set(filters.agents) : undefined;
  const suites = filters.suites?.length ? new Set(filters.suites) : undefined;
  const cases = filters.cases?.length ? new Set(filters.cases) : undefined;
  const statuses = filters.statuses?.length ? new Set(filters.statuses) : undefined;
  return runs.filter((run) =>
    (!batchIds || batchIds.has(run.batchId))
    && (!agents || agents.has(run.agentName))
    && (!suites || suites.has(run.suite ?? ''))
    && (!cases || cases.has(run.caseId))
    && (!statuses || statuses.has(run.status)));
}

/**
 * Keep one task-run per (caseId, agentName, attemptNumber): any graded verdict
 * (passed/failed/skipped/timeout) beats any error/incomplete regardless of
 * recency — a crashed re-run must not displace a real result — otherwise the
 * newest wins.
 */
export function dedupeNewestValid(runs: readonly ScannedTaskRun[]): ScannedTaskRun[] {
  const byKey = new Map<string, ScannedTaskRun>();
  for (const run of runs) {
    const key = `${run.caseId}|${run.agentName}|${run.attemptNumber ?? 0}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? preferredRun(existing, run) : run);
  }
  return [...byKey.values()];
}

const GRADED_STATUSES = new Set<ScannedRunStatus>(['passed', 'failed', 'skipped', 'timeout']);

function preferredRun(a: ScannedTaskRun, b: ScannedTaskRun): ScannedTaskRun {
  const aGraded = GRADED_STATUSES.has(a.status);
  const bGraded = GRADED_STATUSES.has(b.status);
  if (aGraded !== bGraded) return aGraded ? a : b;
  return sortStamp(a) >= sortStamp(b) ? a : b;
}

function sortStamp(run: ScannedTaskRun): string {
  return run.startedAt ?? dirTimestamp(run.runId) ?? run.runId;
}

function batchSortKey(batch: BatchSummaryInfo): string {
  return batch.startedAt ?? batch.batchId;
}

async function scanRunDir(
  runDir: string,
  runId: string,
  caseInfo: CaseInfoMap | undefined,
  warnings: string[],
  batchMeta: Map<string, BatchSummaryInfo>,
): Promise<ScannedTaskRun | undefined> {
  const summary = await readJsonFile(join(runDir, 'summary.json'), warnings, runId);
  const started = await readJsonFile(join(runDir, 'run-started.json'), warnings, runId);
  if (!summary && !started) {
    warnings.push(`Skipped ${runId}: no summary.json or run-started.json`);
    return undefined;
  }

  const startedBatch = isRecord(started?.batch) ? started?.batch : undefined;
  const explicitBatchId = stringField(summary?.batchId) ?? stringField(startedBatch?.batchId);
  const dirStamp = dirTimestamp(runId);
  // The dir name's timestamp is when the run was created — the per-run start time.
  const startedAt = isoFromDirTimestamp(dirStamp);
  const batchId = explicitBatchId ?? `legacy-${(startedAt ?? '').slice(0, 10) || 'unknown'}`;

  if (explicitBatchId && startedBatch && !batchMeta.has(explicitBatchId)) {
    batchMeta.set(explicitBatchId, {
      batchId: explicitBatchId,
      startedAt: stringField(startedBatch.startedAt),
      label: stringField(startedBatch.label),
      argv: stringArray(startedBatch.argv),
      agents: stringArray(startedBatch.agents),
      synthetic: false,
      runCount: 0,
    });
  }
  if (!explicitBatchId && !batchMeta.has(batchId)) {
    batchMeta.set(batchId, {
      batchId,
      startedAt: isoFromDirTimestamp(dirStamp),
      label: `Legacy runs · ${batchId.replace('legacy-', '')}`,
      synthetic: true,
      runCount: 0,
    });
  }

  const startedTestCase = isRecord(started?.testCase) ? started?.testCase : undefined;
  const caseId = stringField(summary?.caseId) ?? stringField(started?.caseId) ?? 'unknown-case';
  const cost = isRecord(summary?.cost) ? summary?.cost : undefined;
  const rollup = isRecord(cost?.rollup) ? cost?.rollup : undefined;
  const byProvider = isRecord(cost?.byProvider) ? cost?.byProvider : undefined;
  const byModel = isRecord(cost?.byModel) ? cost?.byModel : undefined;
  const models = byModel ? Object.keys(byModel) : undefined;
  const score = isRecord(summary?.score) ? numberField(summary?.score.score) : undefined;
  const assertions = isRecord(summary?.assertions)
    ? {
      total: numberField(summary?.assertions.total) ?? 0,
      passed: numberField(summary?.assertions.passed) ?? 0,
      failedRequired: numberField(summary?.assertions.failedRequired) ?? 0,
    }
    : undefined;

  return {
    runId,
    runDir,
    batchId,
    batchSynthetic: !explicitBatchId,
    caseId,
    agentName: stringField(summary?.agentName) ?? stringField(started?.agentName) ?? 'unknown-agent',
    suite: stringField(summary?.suite) ?? stringField(startedTestCase?.suite) ?? caseInfo?.[caseId]?.suite,
    description: stringField(summary?.description) ?? stringField(startedTestCase?.description) ?? caseInfo?.[caseId]?.description,
    attemptNumber: numberField(summary?.attemptNumber ?? started?.attemptNumber),
    attempts: numberField(summary?.attempts ?? started?.attempts),
    status: summary ? normalizeStatus(stringField(summary.status)) : 'incomplete',
    pass: summary?.pass === true,
    startedAt,
    durationMs: numberField(summary?.durationMs),
    exitCode: summary?.exitCode === null ? null : numberField(summary?.exitCode),
    error: stringField(summary?.error),
    score,
    cost: cost
      ? {
        totalCost: numberField(cost.totalCost),
        currency: stringField(cost.currency),
        inputTokens: numberField(rollup?.inputTokens),
        outputTokens: numberField(rollup?.outputTokens),
        cachedInputTokens: numberField(rollup?.cachedInputTokens),
        reasoningTokens: numberField(rollup?.reasoningTokens),
        totalTokens: numberField(rollup?.totalTokens),
        requests: numberField(rollup?.requests),
      }
      : undefined,
    provider: byProvider ? Object.keys(byProvider)[0] : undefined,
    model: models?.[0],
    models,
    assertions,
    hasIndexHtml: existsSync(join(runDir, 'index.html')),
  };
}

function normalizeStatus(status: string | undefined): ScannedRunStatus {
  switch (status) {
    case 'passed':
    case 'failed':
    case 'error':
    case 'skipped':
    case 'timeout':
      return status;
    default:
      return 'incomplete';
  }
}

function dirTimestamp(runId: string): string | undefined {
  return DIR_TIMESTAMP_PATTERN.exec(runId)?.[1];
}

// "2026-06-10T18-04-13-548Z" → "2026-06-10T18:04:13.548Z"
function isoFromDirTimestamp(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!match) return undefined;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

async function readJsonFile(path: string, warnings: string[], runId: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    warnings.push(`Unreadable ${path.endsWith('summary.json') ? 'summary.json' : 'run-started.json'} in ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
