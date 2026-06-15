import { relative } from 'node:path';
import type { BatchSummaryInfo, ScannedTaskRun, WorkspaceScanResult } from '../scan.js';

export interface AggregateInitialState {
  batchIds?: string[];
  agents?: string[];
  suites?: string[];
  statuses?: string[];
  disagreementsOnly?: boolean;
}

/** ScannedTaskRun minus the absolute runDir, plus a report-relative link. */
export interface AggregateTaskRun extends Omit<ScannedTaskRun, 'runDir' | 'hasIndexHtml'> {
  /** Relative href to the run's detail page, when one exists (file:// friendly). */
  indexHref?: string;
}

export interface AggregateReportData {
  generatedAt: string;
  workspace: string;
  batches: BatchSummaryInfo[];
  taskRuns: AggregateTaskRun[];
  initialState?: AggregateInitialState;
  warnings: string[];
}

export function buildAggregateData(input: {
  scan: WorkspaceScanResult;
  workspace: string;
  /** Directory the report HTML will live in — used for relative run links. */
  reportDir: string;
  initialState?: AggregateInitialState;
}): AggregateReportData {
  const taskRuns = input.scan.taskRuns.map((run) => {
    const { runDir, hasIndexHtml, ...rest } = run;
    return {
      ...rest,
      indexHref: hasIndexHtml ? `${relative(input.reportDir, runDir)}/index.html` : undefined,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    workspace: input.workspace,
    batches: input.scan.batches,
    taskRuns,
    initialState: input.initialState,
    warnings: input.scan.warnings,
  };
}
