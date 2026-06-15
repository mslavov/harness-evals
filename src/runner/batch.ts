/**
 * A batch identifies one `harness-evals run` invocation. Every task-run
 * directory created by the invocation records the same batchId, so reports can
 * group and aggregate runs by the command that produced them.
 */
export interface BatchInfo {
  /** `YYYYMMDD-HHMMSS-xxxx` — UTC, lexicographically time-sortable, fs-safe. */
  batchId: string;
  startedAt: string;
  /** Human label for selectors, e.g. "claude-code,pi · 20 cases". */
  label?: string;
  /** CLI arguments verbatim (flags and values only; secrets never pass via flags). */
  argv?: string[];
  agents?: string[];
  caseCount?: number;
  runCount?: number;
}

export function createBatchInfo(input: {
  argv?: string[];
  agents?: string[];
  caseCount?: number;
  runCount?: number;
} = {}): BatchInfo {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
  const random = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  const labelParts: string[] = [];
  if (input.agents && input.agents.length > 0) labelParts.push(input.agents.join(','));
  if (input.caseCount !== undefined) labelParts.push(`${input.caseCount} case${input.caseCount === 1 ? '' : 's'}`);

  return {
    batchId: `${stamp}-${random}`,
    startedAt: now.toISOString(),
    label: labelParts.length > 0 ? labelParts.join(' · ') : undefined,
    argv: input.argv,
    agents: input.agents,
    caseCount: input.caseCount,
    runCount: input.runCount,
  };
}
