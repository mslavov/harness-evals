import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../src/runner/evaluate.js';
import { createBatchInfo } from '../src/runner/batch.js';
import { dedupeNewestValid, filterTaskRuns, scanWorkspaceRuns, type ScannedTaskRun } from '../src/visualization/scan.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-agg-'));
  tempDirs.push(path);
  return path;
}

// A docker stand-in that succeeds instantly — these tests only assert artifact
// contents, not container behavior.
const FAKE_DOCKER = '#!/bin/sh\nif [ "$1" = "rm" ]; then exit 0; fi\necho OK\nexit 0\n';

async function installFakeDocker(root: string): Promise<() => void> {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'docker'), FAKE_DOCKER);
  await chmod(join(binDir, 'docker'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath ? `${binDir}:${previousPath}` : binDir;
  return () => {
    process.env.PATH = previousPath;
  };
}

test('createBatchInfo produces sortable ids and human labels', () => {
  const batch = createBatchInfo({ agents: ['claude-code', 'pi'], caseCount: 20, runCount: 40, argv: ['run', '--agents', 'claude-code,pi'] });
  expect(batch.batchId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
  expect(batch.label).toBe('claude-code,pi · 20 cases');
  expect(batch.argv).toEqual(['run', '--agents', 'claude-code,pi']);
  expect(new Date(batch.startedAt).getTime()).toBeGreaterThan(0);
});

test('runHarness stamps one batchId across all run dirs, with suite in summaries', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  await mkdir(join(root, 'cases'));
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'workspace', 'README.md'), 'workspace');
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
workspace:
  source: workspace
docker:
  image: fake-image
  timeoutMs: 1000
agents:
  a:
    adapter: command
    command: echo
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'one.yaml'), `
id: case-one
suite: pilot
prompt: hi
assert: []
`);
  await writeFile(join(root, 'cases', 'two.yaml'), `
id: case-two
suite: pilot
prompt: hi
assert: []
`);

  let result;
  try {
    result = await runHarness({ cwd: root, cliArgs: ['run', '--agents', 'a'] });
  } finally {
    restoreDocker();
  }

  expect(result.results).toHaveLength(2);
  const summaries = await Promise.all(result.results.map(async (run) =>
    JSON.parse(await readFile(join(run.runDir, 'summary.json'), 'utf8')) as Record<string, unknown>));
  expect(typeof summaries[0]?.batchId).toBe('string');
  expect(summaries[0]?.batchId).toBe(summaries[1]?.batchId);
  expect(summaries.map((summary) => summary.suite)).toEqual(['pilot', 'pilot']);

  const started = JSON.parse(await readFile(join(result.results[0].runDir, 'run-started.json'), 'utf8')) as {
    batch?: { batchId?: string; label?: string; argv?: string[] };
  };
  expect(started.batch?.batchId).toBe(summaries[0]?.batchId as string);
  expect(started.batch?.label).toBe('a · 2 cases');
  expect(started.batch?.argv).toEqual(['run', '--agents', 'a']);
});

test('error-path runs still carry a batchId in summary.json', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'cases'));
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
agents:
  a:
    adapter: command
    command: echo
tests:
  - cases/*.yaml
`);
  // MCP mocks on the command adapter force the setup-error path (persistErrorResult).
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: mcp-unsupported
suite: pilot
prompt: hi
mocks:
  mcp:
    github: github-success
assert: []
`);

  const result = await runHarness({ cwd: root });

  expect(result.results[0]?.status).toBe('error');
  const summary = JSON.parse(await readFile(join(result.results[0].runDir, 'summary.json'), 'utf8')) as Record<string, unknown>;
  expect(typeof summary.batchId).toBe('string');
  expect(summary.suite).toBe('pilot');
});

async function writeRunDir(root: string, name: string, files: Record<string, unknown>): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const SUMMARY_BASE = {
  caseId: 'case-a',
  agentName: 'claude',
  status: 'passed',
  pass: true,
  durationMs: 60_000,
  score: { score: 1, maxScore: 1, buckets: [] },
  cost: {
    available: true,
    totalCost: 2.5,
    currency: 'USD',
    rollup: { totalCost: 2.5, inputTokens: 100, outputTokens: 50, cachedInputTokens: 1000, totalTokens: 1150 },
    byProvider: { anthropic: {} },
    byModel: { 'claude-fable-5': {}, 'claude-haiku-4-5': {} },
  },
  assertions: { total: 1, passed: 1, failedRequired: 0 },
};

test('scanWorkspaceRuns reads modern, legacy, corrupt, and incomplete run dirs', async () => {
  const root = await tempRoot();
  await writeRunDir(root, 'case-a-claude-2026-06-10T18-04-13-548Z-0', {
    'summary.json': { ...SUMMARY_BASE, batchId: '20260610-180413-abcd', suite: 'pilot' },
    'run-started.json': {
      caseId: 'case-a', agentName: 'claude',
      batch: { batchId: '20260610-180413-abcd', startedAt: '2026-06-10T18:04:13.000Z', label: 'claude · 1 case', argv: ['run'], agents: ['claude'] },
      testCase: { suite: 'pilot' },
    },
  });
  // Legacy dir: no batchId anywhere; suite only via run-started testCase.
  await writeRunDir(root, 'case-b-pi-2026-06-09T10-00-00-000Z-1', {
    'summary.json': { ...SUMMARY_BASE, caseId: 'case-b', agentName: 'pi', status: 'failed', pass: false },
    'run-started.json': { caseId: 'case-b', agentName: 'pi', testCase: { suite: 'legacy-suite' } },
  });
  // Corrupt summary, valid run-started → incomplete row + warning.
  await writeRunDir(root, 'case-c-pi-2026-06-09T11-00-00-000Z-2', {
    'summary.json': '{nope',
    'run-started.json': { caseId: 'case-c', agentName: 'pi' },
  });
  // Empty dir → skipped + warning.
  await mkdir(join(root, 'not-a-run'), { recursive: true });
  // Stray file at top level → ignored.
  await writeFile(join(root, 'stray.txt'), 'x');

  const scan = await scanWorkspaceRuns({ artifactRoot: root, caseInfo: { 'case-c': { suite: 'from-config' } } });

  expect(scan.taskRuns).toHaveLength(3);
  const modern = scan.taskRuns.find((run) => run.caseId === 'case-a');
  expect(modern?.batchId).toBe('20260610-180413-abcd');
  expect(modern?.batchSynthetic).toBe(false);
  expect(modern?.suite).toBe('pilot');
  expect(modern?.models).toEqual(['claude-fable-5', 'claude-haiku-4-5']);
  expect(modern?.provider).toBe('anthropic');
  expect(modern?.cost?.cachedInputTokens).toBe(1000);

  const legacy = scan.taskRuns.find((run) => run.caseId === 'case-b');
  expect(legacy?.batchId).toBe('legacy-2026-06-09');
  expect(legacy?.batchSynthetic).toBe(true);
  expect(legacy?.suite).toBe('legacy-suite');

  const incomplete = scan.taskRuns.find((run) => run.caseId === 'case-c');
  expect(incomplete?.status).toBe('incomplete');
  expect(incomplete?.suite).toBe('from-config');

  expect(scan.batches.map((batch) => batch.batchId)).toEqual(['20260610-180413-abcd', 'legacy-2026-06-09']);
  expect(scan.batches[0]?.label).toBe('claude · 1 case');
  expect(scan.batches[1]?.synthetic).toBe(true);
  expect(scan.batches[1]?.runCount).toBe(2);
  expect(scan.warnings.some((warning) => warning.includes('case-c-pi'))).toBe(true);
  expect(scan.warnings.some((warning) => warning.includes('not-a-run'))).toBe(true);
});

function fakeRun(overrides: Partial<ScannedTaskRun>): ScannedTaskRun {
  return {
    runId: 'case-x-agent-2026-06-10T10-00-00-000Z-0',
    runDir: '/tmp/x',
    batchId: 'b1',
    batchSynthetic: false,
    caseId: 'case-x',
    agentName: 'agent',
    status: 'passed',
    pass: true,
    hasIndexHtml: false,
    ...overrides,
  };
}

test('dedupeNewestValid prefers graded verdicts over newer errors, then recency', async () => {
  const oldFailed = fakeRun({ runId: 'a', startedAt: '2026-06-10T10:00:00.000Z', status: 'failed', pass: false });
  const newerError = fakeRun({ runId: 'b', startedAt: '2026-06-10T12:00:00.000Z', status: 'error', pass: false });
  expect(dedupeNewestValid([oldFailed, newerError])).toEqual([oldFailed]);

  const newerPassed = fakeRun({ runId: 'c', startedAt: '2026-06-10T13:00:00.000Z', status: 'passed', pass: true });
  expect(dedupeNewestValid([oldFailed, newerPassed])).toEqual([newerPassed]);

  const olderError = fakeRun({ runId: 'd', startedAt: '2026-06-10T09:00:00.000Z', status: 'error', pass: false });
  expect(dedupeNewestValid([olderError, newerError])).toEqual([newerError]);

  // Distinct attempts are kept apart.
  const attempt1 = fakeRun({ runId: 'e', attemptNumber: 1 });
  const attempt2 = fakeRun({ runId: 'f', attemptNumber: 2 });
  expect(dedupeNewestValid([attempt1, attempt2])).toHaveLength(2);
});

test('filterTaskRuns filters by batch, agent, suite, case, and status', () => {
  const runs = [
    fakeRun({ runId: '1', batchId: 'b1', agentName: 'claude', suite: 's1', caseId: 'c1', status: 'passed' }),
    fakeRun({ runId: '2', batchId: 'b2', agentName: 'pi', suite: 's2', caseId: 'c2', status: 'failed', pass: false }),
  ];
  expect(filterTaskRuns(runs, { batchIds: ['b1'] }).map((run) => run.runId)).toEqual(['1']);
  expect(filterTaskRuns(runs, { agents: ['pi'] }).map((run) => run.runId)).toEqual(['2']);
  expect(filterTaskRuns(runs, { suites: ['s1'] }).map((run) => run.runId)).toEqual(['1']);
  expect(filterTaskRuns(runs, { cases: ['c2'] }).map((run) => run.runId)).toEqual(['2']);
  expect(filterTaskRuns(runs, { statuses: ['failed'] }).map((run) => run.runId)).toEqual(['2']);
  expect(filterTaskRuns(runs, {})).toHaveLength(2);
});

test('buildAggregateData strips runDir, links run reports, and keeps batch order', async () => {
  const { buildAggregateData } = await import('../src/visualization/aggregate/data.js');
  const scan = {
    taskRuns: [
      fakeRun({ runId: 'r1', runDir: '/ws/.harness-evals/runs/r1', hasIndexHtml: true }),
      fakeRun({ runId: 'r2', runDir: '/ws/.harness-evals/runs/r2', hasIndexHtml: false }),
    ],
    batches: [
      { batchId: 'b2', synthetic: false, runCount: 1, startedAt: '2026-06-11T00:00:00.000Z' },
      { batchId: 'b1', synthetic: true, runCount: 1 },
    ],
    warnings: ['warned'],
  };
  const data = buildAggregateData({
    scan,
    workspace: '/ws',
    reportDir: '/ws/.harness-evals/output/report',
    initialState: { batchIds: ['b2'], disagreementsOnly: true },
  });

  expect(data.taskRuns[0]?.indexHref).toBe('../../runs/r1/index.html');
  expect(data.taskRuns[1]?.indexHref).toBeUndefined();
  expect((data.taskRuns[0] as Record<string, unknown>).runDir).toBeUndefined();
  expect(data.batches.map((batch) => batch.batchId)).toEqual(['b2', 'b1']);
  expect(data.initialState?.disagreementsOnly).toBe(true);
  expect(data.warnings).toEqual(['warned']);
});

test('renderAggregateHtml embeds parseable data, charts, and the client renderer', async () => {
  const { buildAggregateData } = await import('../src/visualization/aggregate/data.js');
  const { renderAggregateHtml } = await import('../src/visualization/aggregate/render.js');
  const scan = {
    taskRuns: [fakeRun({ runId: 'r1', runDir: '/ws/runs/r1', hasIndexHtml: false, caseId: 'evil</script><b>' })],
    batches: [{ batchId: 'b1', synthetic: false, runCount: 1 }],
    warnings: [],
  };
  const html = renderAggregateHtml(buildAggregateData({ scan, workspace: '/ws', reportDir: '/ws/report' }));

  // Embedded data must round-trip even with "</script>" inside a field.
  const match = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  const parsed = JSON.parse(match![1] ?? '') as { taskRuns: Array<{ caseId: string }> };
  expect(parsed.taskRuns[0]?.caseId).toBe('evil</script><b>');

  for (const id of ['controls', 'kpi-cards', 'solve-rate-chart', 'efficiency-chart', 'matrix-table', 'duration-strip', 'cost-strip', 'token-bars', 'report-data']) {
    expect(html).toContain(`id="${id}"`);
  }
  for (const fn of ['function wilson', 'function dedupe', 'function applyFilters', 'function aggregateByAgent', 'function renderAll', 'function renderMatrix', 'function renderEfficiency', 'function renderTokens']) {
    expect(html).toContain(fn);
  }
  expect(html).toContain('Instrument+Serif');
  expect(html).toContain('--accent: #eb6c36');
  expect(html).toContain('@media print');
});

test('renderAggregateCsv emits one row per task run with token columns', async () => {
  const { renderAggregateCsv } = await import('../src/visualization/aggregate/csv.js');
  const csv = renderAggregateCsv([
    {
      ...fakeRun({ runId: 'r1', suite: 'pilot, special' }),
      runDir: undefined as never,
      models: ['m1', 'm2'],
      cost: { totalCost: 1.5, currency: 'USD', inputTokens: 10, cachedInputTokens: 100, outputTokens: 5, totalTokens: 115, requests: 3 },
    } as never,
  ]);
  const [header, row] = csv.split('\n');
  expect(header).toBe('batchId,caseId,suite,agentName,provider,models,attemptNumber,status,pass,score,durationMs,cost,currency,inputTokens,cachedInputTokens,outputTokens,totalTokens,requests,startedAt,runId');
  expect(row).toContain('"pilot, special"');
  expect(row).toContain('m1+m2');
  expect(row).toContain('1.5,USD,10,100,5,115,3');
});

test('CLI aggregate view and export work over a fixture workspace', async () => {
  const root = await tempRoot();
  const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
  const runsRoot = join(root, '.harness-evals', 'runs');
  await writeFile(join(root, 'harness-evals.yaml'), 'version: 1\n');
  // Two batches: b-new has a claude run; the legacy run has none.
  await writeRunDir(runsRoot, 'case-a-claude-2026-06-11T01-00-00-000Z-0', {
    'summary.json': { ...SUMMARY_BASE, batchId: '20260611-010000-aaaa', suite: 'pilot' },
    'run-started.json': {
      caseId: 'case-a', agentName: 'claude',
      batch: { batchId: '20260611-010000-aaaa', startedAt: '2026-06-11T01:00:00.000Z', label: 'claude · 1 case' },
    },
  });
  await writeRunDir(runsRoot, 'case-b-pi-2026-06-09T10-00-00-000Z-1', {
    'summary.json': { ...SUMMARY_BASE, caseId: 'case-b', agentName: 'pi', status: 'failed', pass: false },
    'run-started.json': { caseId: 'case-b', agentName: 'pi' },
  });

  const view = Bun.spawnSync(['bun', cliPath, 'view', '--no-open', '--config', join(root, 'harness-evals.yaml')], { cwd: root });
  expect(view.exitCode).toBe(0);
  const reportPath = new TextDecoder().decode(view.stdout).trim();
  expect(reportPath).toBe(join(root, '.harness-evals', 'output', 'report', 'index.html'));
  const html = await readFile(reportPath, 'utf8');
  expect(html).toContain('id="report-data"');
  expect(html).toContain('20260611-010000-aaaa');
  expect(html).toContain('legacy-2026-06-09');

  // Default export = latest batch only → 1 row.
  const latestCsv = Bun.spawnSync(['bun', cliPath, 'export', '--format', 'csv', '--output', join(root, 'latest.csv'), '--config', join(root, 'harness-evals.yaml')], { cwd: root });
  expect(latestCsv.exitCode).toBe(0);
  const latestRows = (await readFile(join(root, 'latest.csv'), 'utf8')).trim().split('\n');
  expect(latestRows).toHaveLength(2);
  expect(latestRows[1]).toContain('case-a');

  // --batch all → both runs.
  const allCsv = Bun.spawnSync(['bun', cliPath, 'export', '--batch', 'all', '--format', 'csv', '--output', join(root, 'all.csv'), '--config', join(root, 'harness-evals.yaml')], { cwd: root });
  expect(allCsv.exitCode).toBe(0);
  expect((await readFile(join(root, 'all.csv'), 'utf8')).trim().split('\n')).toHaveLength(3);

  // Agent filter narrows server-side.
  const piCsv = Bun.spawnSync(['bun', cliPath, 'export', '--batch', 'all', '--agents', 'pi', '--format', 'csv', '--output', join(root, 'pi.csv'), '--config', join(root, 'harness-evals.yaml')], { cwd: root });
  expect(piCsv.exitCode).toBe(0);
  const piRows = (await readFile(join(root, 'pi.csv'), 'utf8')).trim().split('\n');
  expect(piRows).toHaveLength(2);
  expect(piRows[1]).toContain('case-b');
});
