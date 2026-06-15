#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadHarnessConfig } from './config/load.js';
import { buildMatrix } from './runner/matrix.js';
import { runHarness } from './runner/evaluate.js';
import type { CliOverrides } from './config/schema.js';
import { buildRunReport } from './visualization/report.js';
import { renderReport } from './visualization/render.js';
import type { VisualizationFormat } from './visualization/types.js';
import { dedupeNewestValid, filterTaskRuns, scanWorkspaceRuns, type CaseInfoMap, type WorkspaceScanResult } from './visualization/scan.js';
import { buildAggregateData, type AggregateInitialState } from './visualization/aggregate/data.js';
import { renderAggregateHtml } from './visualization/aggregate/render.js';
import { renderAggregateCsv, renderAggregateJson } from './visualization/aggregate/csv.js';

interface ParsedArgs extends CliOverrides {
  command: string;
  configPath?: string;
  runId?: string;
  latest?: boolean;
  open?: boolean;
  noOpen?: boolean;
  port?: number;
  format?: VisualizationFormat;
  output?: string;
  batch?: string;
  statuses?: string[];
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === 'list') {
    const config = await loadHarnessConfig({ configPath: parsed.configPath });
    const matrix = buildMatrix(config, parsed);
    console.log('Agents:');
    for (const name of Object.keys(config.agents)) console.log(`  ${name} (${config.agents[name].adapter})`);
    console.log('\nCases:');
    for (const testCase of config.testCases) console.log(`  ${testCase.id}${testCase.suite ? ` [${testCase.suite}]` : ''}`);
    console.log(`\nMatrix entries: ${matrix.length}`);
    const readyImage = parsed.dockerImage ?? config.docker.image;
    const runtimeImage = readyImage
      ? `ready (${readyImage})`
      : parsed.refreshManagedImage
        ? 'managed (will refresh before run)'
        : 'managed (built automatically during run)';
    console.log(`Runtime image: ${runtimeImage}`);
    return;
  }

  if (parsed.command === 'docker') {
    throw new Error('Managed Docker images are built automatically during harness-evals run. Set docker.image or pass --image to use a ready image and skip managed builds.');
  }

  if (parsed.command === 'view') {
    await viewReport(parsed);
    return;
  }

  if (parsed.command === 'export') {
    await exportReport(parsed);
    return;
  }

  if (parsed.command !== 'run') throw new Error(`Unknown command: ${parsed.command}`);

  const result = await runHarness({
    configPath: parsed.configPath,
    cliArgs: process.argv.slice(2),
    agents: parsed.agents,
    caseId: parsed.caseId,
    suite: parsed.suite,
    concurrency: parsed.concurrency,
    attempts: parsed.attempts,
    provider: parsed.provider,
    model: parsed.model,
    timeoutMs: parsed.timeoutMs,
    dockerImage: parsed.dockerImage,
    refreshManagedImage: parsed.refreshManagedImage,
  });

  printResults(result.results);
  console.log(`\nSummary: ${result.outputPath}`);
  process.exitCode = result.pass ? 0 : 1;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() ?? 'run' : 'run';
  const parsed: ParsedArgs = { command };
  if (command === 'docker' && argv[0] && !argv[0].startsWith('-')) argv.shift();

  while (argv.length > 0) {
    const arg = argv.shift();
    if (!arg) continue;

    switch (arg) {
      case '--config':
        parsed.configPath = readValue(argv, arg);
        break;
      case '--suite':
        parsed.suite = readValue(argv, arg);
        break;
      case '--case':
        parsed.caseId = readValue(argv, arg);
        break;
      case '--agents':
        parsed.agents = readValue(argv, arg).split(',').map((value) => value.trim()).filter(Boolean);
        break;
      case '--concurrency':
        parsed.concurrency = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--attempts':
        parsed.attempts = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--provider':
        parsed.provider = readValue(argv, arg);
        break;
      case '--model':
        parsed.model = readValue(argv, arg);
        break;
      case '--timeout-ms':
        parsed.timeoutMs = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--image':
        parsed.dockerImage = readValue(argv, arg);
        break;
      case '--refresh-managed-image':
        parsed.refreshManagedImage = true;
        break;
      case '--run':
        parsed.runId = readValue(argv, arg);
        break;
      case '--latest':
        parsed.latest = true;
        break;
      case '--open':
        parsed.open = true;
        break;
      case '--no-open':
        parsed.noOpen = true;
        break;
      case '--batch':
        parsed.batch = readValue(argv, arg);
        break;
      case '--status':
        parsed.statuses = readValue(argv, arg).split(',').map((value) => value.trim()).filter(Boolean);
        break;
      case '--port':
        parsed.port = readPositiveInt(readValue(argv, arg), arg);
        break;
      case '--format':
        parsed.format = readFormat(readValue(argv, arg));
        break;
      case '--output':
        parsed.output = readValue(argv, arg);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return parsed;
}

function readValue(argv: string[], flag: string): string {
  const value = argv.shift();
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function readPositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

async function viewReport(parsed: ParsedArgs): Promise<void> {
  const config = await loadHarnessConfig({ configPath: parsed.configPath });

  // Back-compat detail views: a single run dir, or the last invocation's summary.
  if (parsed.runId || parsed.latest) {
    const reportPath = parsed.runId
      ? join(config.artifactRoot, parsed.runId, 'index.html')
      : join(config.outputRoot, 'latest', 'results.html');
    if (!existsSync(reportPath)) throw new Error(`Report not found: ${reportPath}`);

    if (parsed.port !== undefined) {
      const urlPath = parsed.runId ? `/runs/${encodeURIComponent(parsed.runId)}/index.html` : '/latest/results.html';
      await serveReports(config, parsed.port, urlPath, parsed.open ?? false);
      return;
    }

    console.log(reportPath);
    if (parsed.open) openPath(reportPath);
    return;
  }

  // Default: aggregate report over every run in the workspace. The newest
  // batch is pre-selected; all data is embedded so filters work client-side.
  const reportPath = await writeAggregateReport(config, parsed);
  if (parsed.port !== undefined) {
    await serveReports(config, parsed.port, '/report/index.html', parsed.open ?? !parsed.noOpen);
    return;
  }
  console.log(reportPath);
  if (!parsed.noOpen) openPath(reportPath);
}

async function writeAggregateReport(config: Awaited<ReturnType<typeof loadHarnessConfig>>, parsed: ParsedArgs): Promise<string> {
  const scan = await scanAggregateRuns(config);
  const reportDir = join(config.outputRoot, 'report');
  const data = buildAggregateData({
    scan,
    workspace: config.projectRoot,
    reportDir,
    initialState: aggregateInitialState(parsed, scan),
  });
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, 'index.html');
  await writeFile(reportPath, renderAggregateHtml(data));
  return reportPath;
}

async function scanAggregateRuns(config: Awaited<ReturnType<typeof loadHarnessConfig>>): Promise<WorkspaceScanResult> {
  const caseInfo: CaseInfoMap = {};
  for (const testCase of config.testCases) {
    caseInfo[testCase.id] = { suite: testCase.suite, description: testCase.description };
  }
  return scanWorkspaceRuns({ artifactRoot: config.artifactRoot, caseInfo });
}

function aggregateInitialState(parsed: ParsedArgs, scan: WorkspaceScanResult): AggregateInitialState | undefined {
  const state: AggregateInitialState = {};
  const batchIds = resolveBatchIds(parsed.batch, scan);
  if (batchIds) state.batchIds = batchIds;
  if (parsed.agents?.length) state.agents = parsed.agents;
  if (parsed.suite) state.suites = [parsed.suite];
  if (parsed.statuses?.length) state.statuses = parsed.statuses;
  return Object.keys(state).length > 0 ? state : undefined;
}

function resolveBatchIds(batch: string | undefined, scan: WorkspaceScanResult): string[] | undefined {
  if (!batch) return undefined;
  if (batch === 'latest') return scan.batches[0] ? [scan.batches[0].batchId] : undefined;
  if (batch === 'all') return scan.batches.map((entry) => entry.batchId);
  return batch.split(',').map((value) => value.trim()).filter(Boolean);
}

async function exportReport(parsed: ParsedArgs): Promise<void> {
  if (!parsed.format) throw new Error('harness-evals export requires --format html|json|csv');
  if (!parsed.output) throw new Error('harness-evals export requires --output <path>');
  const config = await loadHarnessConfig({ configPath: parsed.configPath });
  if (!config.visualization.enabled) throw new Error('Visualization is disabled');
  if (!config.visualization.formats.includes(parsed.format)) throw new Error(`Visualization format is not enabled: ${parsed.format}`);
  const output = resolve(process.cwd(), parsed.output);

  await mkdir(dirname(output), { recursive: true });

  // Back-compat: copy the last invocation's pre-rendered summary verbatim.
  if (parsed.latest) {
    const latest = join(config.outputRoot, 'latest', `results.${parsed.format}`);
    if (!existsSync(latest)) throw new Error(`Report not found: ${latest}`);
    await copyFile(latest, output);
    console.log(output);
    return;
  }

  if (parsed.runId) {
    const resultPath = join(config.artifactRoot, parsed.runId, 'result.json');
    if (!existsSync(resultPath)) throw new Error(`Run result not found: ${resultPath}`);
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
    const report = buildRunReport(result, { runId: parsed.runId, include: config.visualization.include });
    await writeFile(output, renderReport(report, parsed.format));
    console.log(output);
    return;
  }

  // Default: aggregate export, filtered server-side. --batch defaults to the
  // newest batch; merging several keeps the newest graded attempt per pair.
  const scan = await scanAggregateRuns(config);
  const batchIds = resolveBatchIds(parsed.batch ?? 'latest', scan);
  // Always dedupe: within one batch it's a no-op, and legacy day-buckets can
  // hold superseded attempts that would skew rates.
  const runs = dedupeNewestValid(filterTaskRuns(scan.taskRuns, {
    batchIds,
    agents: parsed.agents,
    suites: parsed.suite ? [parsed.suite] : undefined,
    cases: parsed.caseId ? [parsed.caseId] : undefined,
    statuses: parsed.statuses,
  }));
  const includedBatches = new Set(runs.map((run) => run.batchId));
  const data = buildAggregateData({
    scan: {
      taskRuns: runs,
      batches: scan.batches.filter((entry) => includedBatches.has(entry.batchId)),
      warnings: scan.warnings,
    },
    workspace: config.projectRoot,
    reportDir: dirname(output),
    initialState: includedBatches.size > 0 ? { batchIds: [...includedBatches] } : undefined,
  });
  const content = parsed.format === 'html'
    ? renderAggregateHtml(data)
    : parsed.format === 'csv'
      ? `${renderAggregateCsv(data.taskRuns)}\n`
      : renderAggregateJson(data);
  await writeFile(output, content);
  console.log(output);
}

function readFormat(value: string): VisualizationFormat {
  if (value === 'html' || value === 'json' || value === 'csv') return value;
  throw new Error('--format must be html, json, or csv');
}

async function serveReports(config: Awaited<ReturnType<typeof loadHarnessConfig>>, port: number, initialPath: string, open: boolean): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/') {
        response.writeHead(302, { Location: initialPath });
        response.end();
        return;
      }

      const path = resolveStaticReportPath(config, url.pathname);
      if (!path) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      const fileStat = await stat(path);
      const filePath = fileStat.isDirectory() ? join(path, 'index.html') : path;
      response.writeHead(200, { 'Content-Type': contentType(filePath) });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });

  await new Promise<void>((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}${initialPath}`;
      console.log(url);
      if (open) openPath(url);
    });
    process.once('SIGINT', () => server.close(() => resolveServer()));
    process.once('SIGTERM', () => server.close(() => resolveServer()));
  });
}

function resolveStaticReportPath(config: Awaited<ReturnType<typeof loadHarnessConfig>>, pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  if (decoded.startsWith('/latest/')) return safeJoin(join(config.outputRoot, 'latest'), decoded.slice('/latest/'.length));
  if (decoded.startsWith('/report/')) return safeJoin(join(config.outputRoot, 'report'), decoded.slice('/report/'.length));
  if (decoded.startsWith('/runs/')) return safeJoin(config.artifactRoot, decoded.slice('/runs/'.length));
  return undefined;
}

function safeJoin(root: string, child: string): string | undefined {
  const path = resolve(root, child || 'index.html');
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined;
  return path;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function openPath(path: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.warn(`Could not open report: ${error.message}`));
  child.unref();
}

function printResults(results: Awaited<ReturnType<typeof runHarness>>['results']): void {
  const rows = results.map((result) => ({
    caseId: result.caseId,
    agent: result.agentName,
    status: result.pass ? 'PASS' : 'FAIL',
    exit: String(result.exitCode),
    assertions: `${result.assertions.filter((assertion) => assertion.pass || !assertion.required).length}/${result.assertions.length}`,
    runDir: result.runDir,
  }));

  const widths = {
    caseId: Math.max('CASE'.length, ...rows.map((row) => row.caseId.length)),
    agent: Math.max('AGENT'.length, ...rows.map((row) => row.agent.length)),
    status: Math.max('STATUS'.length, ...rows.map((row) => row.status.length)),
    exit: Math.max('EXIT'.length, ...rows.map((row) => row.exit.length)),
    assertions: Math.max('ASSERT'.length, ...rows.map((row) => row.assertions.length)),
  };

  console.log(`${pad('CASE', widths.caseId)}  ${pad('AGENT', widths.agent)}  ${pad('STATUS', widths.status)}  ${pad('EXIT', widths.exit)}  ${pad('ASSERT', widths.assertions)}  ARTIFACTS`);
  for (const row of rows) {
    console.log(`${pad(row.caseId, widths.caseId)}  ${pad(row.agent, widths.agent)}  ${pad(row.status, widths.status)}  ${pad(row.exit, widths.exit)}  ${pad(row.assertions, widths.assertions)}  ${row.runDir}`);
  }
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function printHelp(): void {
  console.log(`harness-evals

Commands:
  harness-evals run [--config path] [--suite name] [--case id] [--agents a,b] [--concurrency n] [--attempts n]
  harness-evals list [--config path]
  harness-evals view [--config path] [--batch id|latest|all] [--agents a,b] [--suite name] [--status s1,s2] [--no-open] [--port n]
  harness-evals view --run id | --latest [--open] [--port n]
  harness-evals export [--config path] --format html|json|csv --output path [--batch id|latest|all] [--agents a,b] [--suite name] [--case id] [--status s1,s2]
  harness-evals export --run id | --latest --format html|json|csv --output path

View / export:
  view (no --run/--latest) scans every run in the workspace into one
  interactive report (newest batch pre-selected) and opens it; --no-open
  suppresses the browser. export does the same aggregation server-side;
  --batch defaults to latest, comma lists merge batches keeping the newest
  graded attempt per (case, agent). --latest copies the last invocation's
  pre-rendered summary; --run exports a single run directory.

Run flags:
  --provider name     Override provider for selected agents
  --model name        Override model for selected agents
  --attempts n                Override attempt count for selected cases
  --timeout-ms n              Override per-run timeout
  --image ref                 Use a ready Docker image and skip managed builds
  --refresh-managed-image     Rebuild managed Docker image with --pull and --no-cache
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
