#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadHarnessConfig, writeStarterConfig } from './config/load.js';
import { buildMatrix } from './runner/matrix.js';
import { runHarness } from './runner/evaluate.js';
import type { CliOverrides } from './config/schema.js';

interface ParsedArgs extends CliOverrides {
  command: string;
  configPath?: string;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === 'init') {
    const path = resolve(process.cwd(), parsed.configPath ?? 'harness-evals.yaml');
    if (existsSync(path)) throw new Error(`Config already exists: ${path}`);
    await writeStarterConfig(path);
    console.log(`Created ${path}`);
    return;
  }

  if (parsed.command === 'list') {
    const config = await loadHarnessConfig({ configPath: parsed.configPath });
    const matrix = buildMatrix(config, parsed);
    console.log('Agents:');
    for (const name of Object.keys(config.agents)) console.log(`  ${name} (${config.agents[name].adapter})`);
    console.log('\nCases:');
    for (const testCase of config.testCases) console.log(`  ${testCase.id}${testCase.suite ? ` [${testCase.suite}]` : ''}`);
    console.log(`\nMatrix entries: ${matrix.length}`);
    return;
  }

  if (parsed.command === 'docker') {
    throw new Error('harness-evals does not build Docker images. Set docker.image in harness-evals.yaml or pass --image to use an image supplied by the consuming project.');
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
  harness-evals init [--config path]

Run flags:
  --provider name     Override provider for selected agents
  --model name        Override model for selected agents
  --timeout-ms n      Override per-run timeout
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
