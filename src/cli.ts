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

interface ParsedArgs extends CliOverrides {
  command: string;
  configPath?: string;
  runId?: string;
  latest?: boolean;
  open?: boolean;
  port?: number;
  format?: VisualizationFormat;
  output?: string;
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
    agents: parsed.agents,
    caseId: parsed.caseId,
    suite: parsed.suite,
    concurrency: parsed.concurrency,
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
}

async function exportReport(parsed: ParsedArgs): Promise<void> {
  if (!parsed.format) throw new Error('harness-evals export requires --format html|json|csv');
  if (!parsed.output) throw new Error('harness-evals export requires --output <path>');
  const config = await loadHarnessConfig({ configPath: parsed.configPath });
  if (!config.visualization.enabled) throw new Error('Visualization is disabled');
  if (!config.visualization.formats.includes(parsed.format)) throw new Error(`Visualization format is not enabled: ${parsed.format}`);
  const output = resolve(process.cwd(), parsed.output);

  await mkdir(dirname(output), { recursive: true });

  if (!parsed.runId) {
    const latest = join(config.outputRoot, 'latest', `results.${parsed.format}`);
    if (!existsSync(latest)) throw new Error(`Report not found: ${latest}`);
    await copyFile(latest, output);
    console.log(output);
    return;
  }

  const resultPath = join(config.artifactRoot, parsed.runId, 'result.json');
  if (!existsSync(resultPath)) throw new Error(`Run result not found: ${resultPath}`);
  const result = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
  const report = buildRunReport(result, { runId: parsed.runId, include: config.visualization.include });
  await writeFile(output, renderReport(report, parsed.format));
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
  harness-evals run [--config path] [--suite name] [--case id] [--agents a,b] [--concurrency n]
  harness-evals list [--config path]
  harness-evals view [--config path] [--run id] [--latest] [--open] [--port n]
  harness-evals export [--config path] [--run id] --format html|json|csv --output path

Run flags:
  --provider name     Override provider for selected agents
  --model name        Override model for selected agents
  --timeout-ms n              Override per-run timeout
  --image ref                 Use a ready Docker image and skip managed builds
  --refresh-managed-image     Rebuild managed Docker image with --pull and --no-cache
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
