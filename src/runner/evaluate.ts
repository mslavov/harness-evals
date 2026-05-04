import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runAssertions } from '../assertions/builtins.js';
import type { AgentAdapter } from '../adapters/types.js';
import { commandAdapter } from '../adapters/command.js';
import { piAdapter } from '../adapters/pi.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { codexAdapter } from '../adapters/codex.js';
import { cursorAdapter } from '../adapters/cursor.js';
import { loadHarnessConfig, type LoadHarnessConfigOptions } from '../config/load.js';
import type { CliOverrides, LoadedHarnessConfig, MatrixEntry } from '../config/schema.js';
import { runInDocker } from '../docker/runner.js';
import { redactJson, redactionsFromEnv, type Redaction } from '../redaction.js';
import { copyWorkspace } from '../workspace/copy.js';
import { diffWorkspace } from '../workspace/diff.js';
import { snapshotWorkspace } from '../workspace/snapshot.js';
import { buildRunDir, writeEventsSummary, writeOutputSummary, writeRunResult, writeWorkspaceDiff } from './artifacts.js';
import { buildMatrix } from './matrix.js';
import type { HarnessRunResult, TestRunResult } from './result.js';

export interface RunHarnessOptions extends LoadHarnessConfigOptions, CliOverrides {
  adapters?: AgentAdapter[];
}

export async function runHarness(options: RunHarnessOptions = {}): Promise<HarnessRunResult> {
  const config = await loadHarnessConfig(options);
  const matrix = buildMatrix(config, options);
  const adapters = buildAdapters(options.adapters);
  const concurrency = options.concurrency ?? 1;
  const results = await mapConcurrent(matrix, concurrency, (entry) => runTestCase(config, entry, adapters));
  const redactions = redactionsFromEnv(config.docker.envAllowlist);
  const outputPath = await writeOutputSummary(config.outputRoot, results, redactions);

  return {
    pass: results.every((result) => result.pass),
    results,
    outputPath,
  };
}

export async function runTestCase(
  config: LoadedHarnessConfig,
  entry: MatrixEntry,
  adapters: Map<string, AgentAdapter> = buildAdapters(),
): Promise<TestRunResult> {
  const runDir = buildRunDir(config.artifactRoot, entry.testCase.id, entry.agentName);
  const workspaceDir = join(runDir, 'workspace');
  const configDir = join(runDir, 'config');
  const redactions = redactionsFromEnv(unique([...entry.docker.envAllowlist, ...(entry.agent.envAllowlist ?? []), ...(entry.agent.env ?? []), entry.agent.apiKeyEnv]));
  let cleanupPaths: string[] = [];

  try {
    await mkdir(configDir, { recursive: true });
    await copyWorkspace(entry.workspace.fixture ?? entry.workspace.source, workspaceDir, { ignore: entry.workspace.ignore });
    const beforeSnapshot = await snapshotWorkspace(workspaceDir, entry.workspace.ignore);

    const adapter = adapters.get(entry.agent.adapter);
    if (!adapter) throw new Error(`Unknown adapter: ${entry.agent.adapter}`);

    const plan = await adapter.prepareRun({
      projectRoot: config.projectRoot,
      agentName: entry.agentName,
      agent: entry.agent,
      testCase: entry.testCase,
      prompt: entry.testCase.prompt,
      runDir,
      workspaceDir,
      configDir,
      workspace: entry.workspace,
      docker: entry.docker,
    });
    cleanupPaths = plan.cleanupPaths ?? [];

    const envNames = unique([...entry.docker.envAllowlist, ...plan.envNames]);
    const docker = await runInDocker({
      image: entry.docker.image,
      workspaceDir,
      workspaceTarget: entry.workspace.containerPath,
      configDir,
      configTarget: entry.docker.configRoot,
      home: entry.docker.home,
      argv: plan.argv,
      workdir: plan.cwd,
      envNames,
      envValues: plan.envValues,
      configMounts: plan.configMounts,
      runDir,
      caseId: entry.testCase.id,
      agentName: entry.agentName,
      timeoutMs: plan.timeoutMs ?? entry.agent.timeoutMs ?? entry.docker.timeoutMs,
      redactions,
    });

    const events = await adapter.parseEvents({ stdout: docker.stdout, stderr: docker.stderr, plan });
    if (docker.errorMessage) events.errors.push(docker.errorMessage);
    const output = events.finalOutput || docker.stdout.trim();
    const afterSnapshot = await snapshotWorkspace(workspaceDir, entry.workspace.ignore);
    const workspace = diffWorkspace(beforeSnapshot, afterSnapshot);

    await writeEventsSummary(join(runDir, 'events-summary.json'), events, redactions);
    await writeWorkspaceDiff(join(runDir, 'workspace-diff.json'), workspace);

    const metadata = redactJson({
      caseId: entry.testCase.id,
      agentName: entry.agentName,
      runDir,
      ...(plan.metadata ?? {}),
      agent: {
        adapter: entry.agent.adapter,
        argv: docker.argv,
        exitCode: docker.exitCode,
        durationMs: docker.durationMs,
      },
      docker: {
        image: docker.image,
        command: docker.command,
      },
      events: {
        finalOutput: output,
        toolCalls: events.toolCalls,
        errors: events.errors,
        summaryPath: join(runDir, 'events-summary.json'),
      },
      workspace,
    }, redactions);

    const assertions = await runAssertions(entry.testCase.assert, {
      output,
      exitCode: docker.exitCode,
      events,
      workspace,
      metadata,
    });
    const pass = assertions.every((assertion) => assertion.pass || !assertion.required) && !docker.errorMessage;
    const result: TestRunResult = {
      caseId: entry.testCase.id,
      agentName: entry.agentName,
      pass,
      exitCode: docker.exitCode,
      durationMs: docker.durationMs,
      output,
      runDir,
      assertions,
      events,
      workspace,
      error: docker.errorMessage,
      metadata,
    };

    await writeRunResult(join(runDir, 'result.json'), result, redactions);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: TestRunResult = {
      caseId: entry.testCase.id,
      agentName: entry.agentName,
      pass: false,
      exitCode: null,
      durationMs: 0,
      output: '',
      runDir,
      assertions: [{ type: 'error', pass: false, reason: message, required: true }],
      events: { finalOutput: '', toolCalls: [], errors: [message] },
      workspace: { added: [], changed: [], deleted: [] },
      error: message,
      metadata: { caseId: entry.testCase.id, agentName: entry.agentName, runDir },
    };
    await writeRunResult(join(runDir, 'result.json'), result, redactions);
    return result;
  } finally {
    await Promise.all(cleanupPaths.map((path) => rm(path, { force: true })));
  }
}

export function buildAdapters(extraAdapters: AgentAdapter[] = []): Map<string, AgentAdapter> {
  const adapters = [commandAdapter, piAdapter, claudeCodeAdapter, codexAdapter, cursorAdapter, ...extraAdapters];
  return new Map(adapters.map((adapter) => [adapter.name, adapter]));
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));

  return results;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
