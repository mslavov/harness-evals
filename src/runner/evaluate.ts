import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runAssertions } from '../assertions/builtins.js';
import { safeStepId } from '../step-id.js';
import { builtInAdapters, createAdapterRegistry, validateAdapterReferences, type AdapterRegistry } from '../adapters/registry.js';
import type { AgentAdapter, AdapterContinuation, AgentStepRunPlan, MockRuntimePlan } from '../adapters/types.js';
import { loadHarnessConfig, type LoadHarnessConfigOptions } from '../config/load.js';
import type { CliOverrides, LoadedHarnessConfig, MatrixEntry, ProjectScoringConfig } from '../config/schema.js';
import { buildCostSummary, buildStepCostReport, mergeCostReports, missingCostReport, type CostDimensions, type CostReportEntry } from '../cost/rollup.js';
import type { CostSummary } from '../cost/types.js';
import { ImageResolutionError, resolveDockerImage, type ImageResolutionAgent, type ImageResolutionResult } from '../docker/image-resolver.js';
import { runInDocker } from '../docker/runner.js';
import { seedWorkspaceFromImage } from '../docker/seed.js';
import { redactFile, redactJson, redactionsFromEnv, type Redaction } from '../redaction.js';
import { copyWorkspace } from '../workspace/copy.js';
import { diffWorkspace } from '../workspace/diff.js';
import { snapshotWorkspace, type WorkspaceSnapshot } from '../workspace/snapshot.js';
import { createOutputDispatcher, type OutputDispatcher } from '../output/dispatcher.js';
import { createOutputProviderRegistry, type OutputProviderRegistry } from '../output/registry.js';
import { readMockCallLogs, strictMockFailures, summarizeMockCalls } from '../mocks/calls.js';
import { applyMockRuntimeToPlan, buildMockConfigPayload as buildStagedMockConfigPayload, mergeMockDeclarations, stageMockRuntime } from '../mocks/stage.js';
import type { MockCallSummary } from '../events/types.js';
import { createConfiguredJudgeRunner } from '../judge/configured.js';
import type { JudgeRunner } from '../judge/types.js';
import type { MockCallRecord } from '../mocks/types.js';
import { buildScenarioScoreSummary, buildScoreSummary } from '../scoring/index.js';
import { applyHiddenPatch, captureModelPatch } from '../verifier/patch.js';
import { runVerifier, verifierSetupError } from '../verifier/run.js';
import { shouldCaptureModelPatch, type HiddenPatchResult, type ModelPatchArtifact, type VerifierRunResult } from '../verifier/types.js';
import { buildRunDir } from './artifacts.js';
import { createBatchInfo, type BatchInfo } from './batch.js';
import { buildMatrix } from './matrix.js';
import type { HarnessRunResult, PassAtKSummary, ScenarioRunContext, ScenarioRunStatus, ScenarioStepResult, ScenarioStepStatus, TestRunResult } from './result.js';

export interface RunHarnessOptions extends LoadHarnessConfigOptions, CliOverrides {
  adapters?: AgentAdapter[];
  judgeRunner?: JudgeRunner;
  /** CLI argv (flags only) recorded as batch metadata for report grouping. */
  cliArgs?: string[];
}

export async function runHarness(options: RunHarnessOptions = {}): Promise<HarnessRunResult> {
  const config = await loadHarnessConfig(options);
  const registry = await createRunAdapterRegistry(config, options.adapters);
  const outputRegistry = await createOutputProviderRegistry({
    projectRoot: config.projectRoot,
    outputRoot: config.outputRoot,
    providers: config.output.providers,
    visualization: config.visualization,
  });
  validateAdapterReferences(registry, Object.values(config.agents).map((agent) => agent.adapter));
  const matrix = buildMatrix(config, options);
  validateAdapterReferences(registry, matrix.map((entry) => entry.agent.adapter));
  const concurrency = options.concurrency ?? 1;
  const imageAgents = buildImageResolutionAgents(matrix);
  let sharedImageResolution: Promise<ImageResolutionResult> | undefined;
  const resolveSharedImage = options.refreshManagedImage && matrix.length > 0 && matrix.every((entry) => !entry.docker.image)
    ? () => {
      sharedImageResolution ??= resolveDockerImage({
        projectRoot: config.projectRoot,
        docker: matrix[0].docker,
        selectedAgents: imageAgents,
        adapterRegistry: registry,
        refreshManagedImage: true,
      });
      return sharedImageResolution;
    }
    : undefined;
  const judgeRunner = options.judgeRunner ?? createConfiguredJudgeRunner({ config, registry });
  const batch = createBatchInfo({
    argv: options.cliArgs,
    agents: unique(matrix.map((entry) => entry.agentName)),
    caseCount: new Set(matrix.map((entry) => entry.testCase.id)).size,
    runCount: matrix.length,
  });
  const results = await mapConcurrent(matrix, concurrency, (entry) => runTestCase(
    config,
    entry,
    registry,
    outputRegistry,
    imageAgents,
    judgeRunner,
    options.refreshManagedImage,
    resolveSharedImage,
    batch,
  ));
  const cost = buildHarnessCostSummary(results);
  const passAtK = buildPassAtKSummary(results);
  const outputPath = await writeHarnessSummary(config, outputRegistry, registry, matrix, results, cost, passAtK, batch);

  return {
    pass: results.every((result) => result.pass),
    results,
    cost,
    passAtK,
    outputPath,
  };
}

export async function runTestCase(
  config: LoadedHarnessConfig,
  entry: MatrixEntry,
  registry?: AdapterRegistry,
  outputRegistry?: OutputProviderRegistry,
  imageAgents?: ImageResolutionAgent[],
  judgeRunner?: JudgeRunner,
  refreshManagedImage?: boolean,
  resolveImage?: () => Promise<ImageResolutionResult>,
  batch?: BatchInfo,
): Promise<TestRunResult> {
  const runDir = buildRunDir(config.artifactRoot, entry.testCase.id, entry.agentName);
  const runId = basename(runDir);
  const workspaceDir = join(runDir, 'workspace');
  const baseWorkspaceDir = join(runDir, 'base-workspace');
  const configDir = join(runDir, 'config');
  const steps: ScenarioStepResult[] = [];
  let redactions: Redaction[] = [];
  const runStartedAt = Date.now();
  // Programmatic single-case callers don't pass a batch — every run dir still
  // gets a real batchId so reports can always group it.
  const activeBatch = batch ?? createBatchInfo({ agents: [entry.agentName], caseCount: 1, runCount: 1 });
  let cleanupPaths: string[] = [];
  let dispatcher: OutputDispatcher | undefined;
  let currentStepId: string | undefined;

  try {
    const adapterRegistry = registry ?? await createRunAdapterRegistry(config);
    redactions = redactionsFromEnv(runRedactionEnvNames(config, entry, adapterRegistry));
    const activeOutputRegistry = outputRegistry ?? await createOutputProviderRegistry({
      projectRoot: config.projectRoot,
      outputRoot: config.outputRoot,
      providers: config.output.providers,
      visualization: config.visualization,
    });
    dispatcher = await createOutputDispatcher({
      projectRoot: config.projectRoot,
      runId,
      scenarioId: entry.testCase.id,
      agentName: entry.agentName,
      redactions,
      providers: activeOutputRegistry.create({ runId, runDir, scenarioId: entry.testCase.id, agentName: entry.agentName }),
    });

    await dispatcher.emit({
      type: 'run.started',
      payload: {
        runId,
        scenarioId: entry.testCase.id,
        caseId: entry.testCase.id,
        agentName: entry.agentName,
        attemptIndex: entry.attemptIndex,
        attemptNumber: entry.attemptNumber,
        attempts: entry.attempts,
        runDir,
        batch: activeBatch,
        testCase: {
          id: entry.testCase.id,
          description: entry.testCase.description,
          suite: entry.testCase.suite,
          sourcePath: entry.testCase.sourcePath,
          stepCount: entry.testCase.steps.length,
        },
        agent: {
          adapter: entry.agent.adapter,
          label: entry.agent.label,
          model: entry.agent.model,
          provider: entry.agent.provider,
        },
        docker: {
          image: entry.docker.image,
          workspaceTarget: entry.workspace.containerPath,
          configTarget: entry.docker.configRoot,
        },
        providerFailures: dispatcher.providerFailures,
      },
    });

    const activeJudgeRunner = judgeRunner ?? createConfiguredJudgeRunner({ config, registry: adapterRegistry });
    const adapter = adapterRegistry.require(entry.agent.adapter);
    if (!adapter.applyMcpMocks && hasDeclaredMcpMocks(entry)) {
      throw new Error(`MCP mocks are declared for ${entry.testCase.id}, but adapter ${entry.agent.adapter} does not support applyMcpMocks`);
    }
    const imageResolution = await resolveAndEmitImage({
      config,
      entry,
      adapterRegistry,
      dispatcher,
      imageAgents: imageAgents ?? [{ agentName: entry.agentName, agent: entry.agent }],
      refreshManagedImage,
      resolveImage,
    });
    const dockerImage = imageResolution.image;

    await mkdir(configDir, { recursive: true });
    if (entry.workspace.seedFromImage) {
      // Harbor/DeepSWE-style: the repo lives inside the resolved image. Extract
      // it (with .git) into the bind-mounted workspace so agent edits persist
      // into the verifier container, which sees the same mount.
      await seedWorkspaceFromImage({
        image: dockerImage,
        seedPath: entry.workspace.seedPath ?? '/app',
        workspaceDir,
        timeoutMs: entry.docker.timeoutMs,
      });
    } else {
      await copyWorkspace(entry.workspace.fixture ?? entry.workspace.source, workspaceDir, { ignore: entry.workspace.ignore });
    }
    if (!entry.workspace.seedFromImage && entry.testCase.verifier && shouldCaptureModelPatch(entry.testCase.verifier)) {
      await copyWorkspace(workspaceDir, baseWorkspaceDir, { ignore: [] });
      cleanupPaths.push(baseWorkspaceDir);
    }
    const beforeSnapshot = await snapshotWorkspace(workspaceDir, entry.workspace.ignore);

    const context: ScenarioRunContext = {
      scenarioId: entry.testCase.id,
      testCaseId: entry.testCase.id,
      agentName: entry.agentName,
      runId,
      runDir,
      workspaceDir,
      configDir,
    };
    let skipReason: string | undefined;

    for (const [stepIndex, step] of entry.testCase.steps.entries()) {
      currentStepId = safeStepId(step.id);
      if (skipReason) {
        steps.push(await skipScenarioStep({
          entry,
          dispatcher,
          step,
          stepIndex,
          context,
          runDir,
          workspaceDir,
          beforeSnapshot,
          scoring: config.scoring,
          reason: skipReason,
        }));
        continue;
      }

      const execution = await executeScenarioStep({
        config,
        entry,
        adapter,
        adapterRegistry,
        dispatcher,
        context,
        step,
        stepIndex,
        beforeSnapshot,
        dockerImage,
        redactions,
        judgeRunner: activeJudgeRunner,
      });
      cleanupPaths.push(...execution.cleanupPaths);
      steps.push(execution.result);
      context.continuation = execution.continuation;
      skipReason = skipReasonForStep(execution.result);
    }

    const finalSnapshot = await snapshotWorkspace(workspaceDir, entry.workspace.ignore);
    const workspace = diffWorkspace(beforeSnapshot, finalSnapshot);
    await dispatcher.emit({ type: 'workspace.diff', payload: workspace });

    const verifierArtifacts = await runVerifierArtifacts({
      entry,
      dispatcher,
      runDir,
      baseWorkspaceDir,
      workspaceDir,
      configDir,
      dockerImage,
      projectRoot: config.projectRoot,
    });

    const result = buildTestRunResult({
      entry,
      context,
      steps,
      workspace,
      verifier: verifierArtifacts.verifier,
      modelPatch: verifierArtifacts.modelPatch,
      hiddenPatch: verifierArtifacts.hiddenPatch,
      durationMs: Date.now() - runStartedAt,
      scoring: config.scoring,
      redactions,
    });

    await dispatcher.emit({ type: 'scenario.scoreSummary', payload: result.score });
    await dispatcher.emit({ type: 'scenario.costSummary', payload: result.cost });
    await dispatcher.emit({ type: 'run.result', payload: result });
    const runVisualization = runVisualizationReportPayload(config, result);
    if (runVisualization) await dispatcher.emit({ type: 'visualization.report', payload: runVisualization });
    await dispatcher.emit({ type: 'run.summary', payload: buildRunSummary(result, dispatcher, activeBatch) });
    await dispatcher.finalize({ status: outputStatusForRun(result.status) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = buildSetupErrorResult(entry, runId, runDir, steps, message, Date.now() - runStartedAt, redactions, config.scoring);

    if (dispatcher) await persistErrorResult(config, dispatcher, result, currentStepId, activeBatch);
    return result;
  } finally {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  }
}

interface ExecuteScenarioStepInput {
  config: LoadedHarnessConfig;
  entry: MatrixEntry;
  adapter: AgentAdapter;
  adapterRegistry: AdapterRegistry;
  dispatcher: OutputDispatcher;
  context: ScenarioRunContext;
  step: MatrixEntry['testCase']['steps'][number];
  stepIndex: number;
  beforeSnapshot: WorkspaceSnapshot;
  dockerImage: string;
  redactions: readonly Redaction[];
  judgeRunner?: JudgeRunner;
}

interface ExecuteScenarioStepOutput {
  result: ScenarioStepResult;
  continuation?: AdapterContinuation;
  cleanupPaths: string[];
}

async function executeScenarioStep(input: ExecuteScenarioStepInput): Promise<ExecuteScenarioStepOutput> {
  const stepId = safeStepId(input.step.id);
  const stepDir = join(input.context.runDir, 'steps', stepId);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let plan: AgentStepRunPlan | undefined;
  let docker: Awaited<ReturnType<typeof runInDocker>> | undefined;
  let stdout = '';
  let stderr = '';
  let output = '';
  let commandEmitted = false;
  let stdoutEmitted = false;
  let stderrEmitted = false;
  let eventsEmitted = false;
  let assertionsEmitted = false;
  let costEmitted = false;
  let scoreEmitted = false;
  let mockCallsEmitted = false;
  let mocks: MockRuntimePlan | undefined;
  let mockCalls: MockCallRecord[] = [];

  await mkdir(stepDir, { recursive: true });
  await input.dispatcher.emit({
    type: 'step.started',
    stepId,
    payload: {
      stepId,
      originalStepId: input.step.id,
      stepIndex: input.stepIndex,
      prompt: input.step.prompt,
      timeoutMs: input.step.timeoutMs ?? input.entry.agent.timeoutMs ?? input.entry.docker.timeoutMs,
      status: 'running',
    },
  });

  try {
    const declarations = mergeMockDeclarations(input.config.mocks, input.entry.testCase.mocks, input.step.mocks);
    if (declarations) {
      mocks = await stageMockRuntime({
        projectRoot: input.config.projectRoot,
        defaults: input.config.mocks,
        testCaseMocks: input.entry.testCase.mocks,
        stepMocks: input.step.mocks,
        adapter: input.adapter,
        agentName: input.entry.agentName,
        agentAdapterName: input.entry.agent.adapter,
        testCaseId: input.entry.testCase.id,
        configDir: input.context.configDir,
        configTarget: input.entry.docker.configRoot,
        workspaceDir: input.context.workspaceDir,
        stepId,
      });
      if (mocks) {
        await input.dispatcher.emit({
          type: 'mock.config',
          stepId,
          payload: {
            stepId,
            originalStepId: input.step.id,
            stepIndex: input.stepIndex,
            ...buildStagedMockConfigPayload({
              declarations,
              testCaseMocks: input.entry.testCase.mocks,
              stepMocks: input.step.mocks,
              runtime: mocks,
            }),
          },
        });
      }
    }

    const stepAgent = mergeStepAgentConfig(input.entry.agent, input.step);
    plan = await input.adapter.prepareStep({
      projectRoot: input.config.projectRoot,
      agentName: input.entry.agentName,
      agent: stepAgent,
      testCase: input.entry.testCase,
      step: input.step,
      stepIndex: input.stepIndex,
      prompt: input.step.prompt,
      runDir: input.context.runDir,
      stepDir,
      workspaceDir: input.context.workspaceDir,
      configDir: input.context.configDir,
      workspace: input.entry.workspace,
      docker: input.entry.docker,
      mocks,
      continuation: input.context.continuation,
    });
    applyMockRuntimeToPlan(plan, mocks);

    const envNames = unique([...input.entry.docker.envAllowlist, ...plan.envNames]);
    const timeoutMs = plan.timeoutMs ?? input.step.timeoutMs ?? input.entry.agent.timeoutMs ?? input.entry.docker.timeoutMs;
    docker = await runInDocker({
      image: input.dockerImage,
      workspaceDir: input.context.workspaceDir,
      workspaceTarget: input.entry.workspace.containerPath,
      configDir: input.context.configDir,
      configTarget: input.entry.docker.configRoot,
      home: input.entry.docker.home,
      argv: plan.argv,
      workdir: plan.cwd,
      envNames,
      envValues: plan.envValues,
      configMounts: plan.configMounts,
      caseId: input.entry.testCase.id,
      agentName: input.entry.agentName,
      timeoutMs,
      stdoutFile: join(stepDir, 'stdout.log'),
      stderrFile: join(stepDir, 'stderr.log'),
    });
    stdout = docker.stdout;
    stderr = docker.stderr;
    // The runner streams raw output; redact the artifacts before anything reads them.
    await redactFile(docker.stdoutPath, input.redactions);
    await redactFile(docker.stderrPath, input.redactions);

    await input.dispatcher.emit({ type: 'step.command', stepId, payload: docker.commandMetadata });
    commandEmitted = true;
    await input.dispatcher.emit({ type: 'step.stdout', stepId, payload: streamPayload(docker, 'stdout', stdout) });
    stdoutEmitted = true;
    await input.dispatcher.emit({ type: 'step.stderr', stepId, payload: streamPayload(docker, 'stderr', stderr) });
    stderrEmitted = true;

    mockCalls = await readMockCallLogs(mocks);
    for (const call of mockCalls) await input.dispatcher.emit({ type: 'mock.call', stepId, payload: call });
    mockCallsEmitted = true;
    const unmatchedStrictMocks = strictMockFailures(mockCalls);

    const events = await input.adapter.parseEvents({
      stdout,
      stderr,
      plan,
      stdoutPath: docker.stdoutPath,
      stdoutTruncated: docker.stdoutTruncated,
    });
    const mockCallSummaries = summarizeMockCallRecords(mockCalls);
    if (mockCallSummaries.length > 0) events.mockCalls = mockCallSummaries;
    if (docker.errorMessage) events.errors.push(docker.errorMessage);
    for (const call of unmatchedStrictMocks) events.errors.push(call.error ?? `Unmatched ${call.surface} mock call: ${call.tool}`);
    output = events.finalOutput || stdout.trim();
    const workspace = diffWorkspace(input.beforeSnapshot, await snapshotWorkspace(input.context.workspaceDir, input.entry.workspace.ignore));
    const metadata = buildStepMetadata({
      entry: input.entry,
      context: input.context,
      step: input.step,
      stepIndex: input.stepIndex,
      stepId,
      stepDir,
      plan,
      docker,
      events,
      output,
      workspace,
      status: 'passed',
      startedAt,
      completedAt: new Date().toISOString(),
      redactions: input.redactions,
      mockCalls,
    });
    const assertions = await runAssertions(input.step.assert, {
      output,
      stdout,
      stderr,
      exitCode: docker.exitCode,
      events,
      workspace,
      metadata,
      mockCalls: mockCallSummaries,
    }, {
      judgeDefaults: input.config.judge,
      judgeRunner: input.judgeRunner,
      redactions: input.redactions,
      onJudgeRecord: async (record) => {
        await input.dispatcher.emit({ type: 'step.judge', stepId, payload: record });
      },
    });
    for (const call of unmatchedStrictMocks) assertions.push(errorAssertion(call.error ?? `Unmatched ${call.surface} mock call: ${call.tool}`));
    await input.dispatcher.emit({ type: 'step.assertions', stepId, payload: assertions });
    assertionsEmitted = true;

    const stepCost = buildStepCostReport({
      adapterCost: events.cost,
      assertions,
      dimensions: costDimensions(input.entry, input.context, input.step, input.stepIndex, stepId),
    });
    events.cost = stepCost;
    await input.dispatcher.emit({ type: 'step.events', stepId, payload: events });
    eventsEmitted = true;
    await input.dispatcher.emit({ type: 'step.cost', stepId, payload: stepCost });
    costEmitted = true;

    const finalStatus = determineStepStatus(docker, assertions);
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    const score = buildScoreSummary(input.config.scoring, { assertions, durationMs, cost: stepCost });
    await input.dispatcher.emit({ type: 'step.score', stepId, payload: score });
    scoreEmitted = true;
    const result: ScenarioStepResult = {
      id: stepId,
      originalStepId: input.step.id,
      stepIndex: input.stepIndex,
      status: finalStatus,
      pass: finalStatus === 'passed',
      exitCode: docker.exitCode,
      durationMs,
      output,
      stdout,
      stderr,
      command: docker.commandMetadata,
      events,
      cost: stepCost,
      assertions,
      score,
      workspace,
      startedAt,
      completedAt,
      error: docker.errorMessage,
      metadata: buildStepMetadata({
        entry: input.entry,
        context: input.context,
        step: input.step,
        stepIndex: input.stepIndex,
        stepId,
        stepDir,
        plan,
        docker,
        events,
        output,
        workspace,
        status: finalStatus,
        startedAt,
        completedAt,
        redactions: input.redactions,
        mockCalls,
      }),
    };

    await input.dispatcher.emit({ type: 'step.completed', stepId, payload: buildStepCompletedPayload(result) });
    return { result, continuation: plan.continuation, cleanupPaths: plan.cleanupPaths ?? [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = new Date().toISOString();
    const events: ScenarioStepResult['events'] = { finalOutput: output, toolCalls: [], errors: [message] };
    if (!commandEmitted && docker) await input.dispatcher.emit({ type: 'step.command', stepId, payload: docker.commandMetadata });
    if (!stdoutEmitted) await input.dispatcher.emit({ type: 'step.stdout', stepId, payload: streamPayload(docker, 'stdout', stdout) });
    if (!stderrEmitted) await input.dispatcher.emit({ type: 'step.stderr', stepId, payload: streamPayload(docker, 'stderr', stderr || message) });
    if (!mockCallsEmitted) {
      try {
        mockCalls = await readMockCallLogs(mocks);
        for (const call of mockCalls) await input.dispatcher.emit({ type: 'mock.call', stepId, payload: call });
      } catch (mockError) {
        events.errors.push(mockError instanceof Error ? mockError.message : String(mockError));
      }
      mockCallsEmitted = true;
    }
    const mockCallSummaries = summarizeMockCallRecords(mockCalls);
    if (mockCallSummaries.length > 0) events.mockCalls = mockCallSummaries;
    const assertions = [errorAssertion(message)];
    const stepCost = missingCostReport('step_error', costDimensions(input.entry, input.context, input.step, input.stepIndex, stepId));
    events.cost = stepCost;
    if (!eventsEmitted) await input.dispatcher.emit({ type: 'step.events', stepId, payload: events });
    if (!costEmitted) await input.dispatcher.emit({ type: 'step.cost', stepId, payload: stepCost });

    const workspace = diffWorkspace(input.beforeSnapshot, await snapshotWorkspace(input.context.workspaceDir, input.entry.workspace.ignore));
    if (!assertionsEmitted) await input.dispatcher.emit({ type: 'step.assertions', stepId, payload: assertions });
    const durationMs = Date.now() - startedAtMs;
    const score = buildScoreSummary(input.config.scoring, { assertions, durationMs, cost: stepCost });
    if (!scoreEmitted) await input.dispatcher.emit({ type: 'step.score', stepId, payload: score });

    const result: ScenarioStepResult = {
      id: stepId,
      originalStepId: input.step.id,
      stepIndex: input.stepIndex,
      status: 'error',
      pass: false,
      exitCode: docker?.exitCode ?? null,
      durationMs,
      output,
      stdout,
      stderr: stderr || message,
      command: docker?.commandMetadata,
      events,
      cost: stepCost,
      assertions,
      score,
      workspace,
      startedAt,
      completedAt,
      error: message,
      metadata: redactJson({
        caseId: input.entry.testCase.id,
        scenarioId: input.context.scenarioId,
        agentName: input.entry.agentName,
        runId: input.context.runId,
        runDir: input.context.runDir,
        step: {
          id: stepId,
          originalStepId: input.step.id,
          stepIndex: input.stepIndex,
          status: 'error',
          startedAt,
          completedAt,
        },
        ...(plan?.metadata ?? {}),
        mocks: buildMockMetadata(plan, mockCalls),
        agent: {
          adapter: input.entry.agent.adapter,
          argv: docker?.argv ?? plan?.argv,
          exitCode: docker?.exitCode ?? null,
          durationMs: docker?.durationMs ?? 0,
        },
        docker: docker ? {
          image: docker.image,
          command: docker.command,
          timedOut: docker.timedOut,
        } : undefined,
        events: {
          finalOutput: output,
          toolCalls: events.toolCalls,
          mockCalls: events.mockCalls ?? [],
          errors: events.errors,
          cost: events.cost,
          summaryPath: join(stepDir, 'events-summary.json'),
        },
        artifacts: {
          stdoutPath: join(stepDir, 'stdout.log'),
          stderrPath: join(stepDir, 'stderr.log'),
          commandPath: join(stepDir, 'command.redacted.json'),
        },
        workspace,
        error: message,
      }, input.redactions) as Record<string, unknown>,
    };

    await input.dispatcher.emit({ type: 'step.completed', stepId, payload: buildStepCompletedPayload(result) });
    return { result, continuation: undefined, cleanupPaths: plan?.cleanupPaths ?? [] };
  }
}

async function skipScenarioStep(input: {
  entry: MatrixEntry;
  dispatcher: OutputDispatcher;
  step: MatrixEntry['testCase']['steps'][number];
  stepIndex: number;
  context: ScenarioRunContext;
  runDir: string;
  workspaceDir: string;
  beforeSnapshot: WorkspaceSnapshot;
  scoring: ProjectScoringConfig;
  reason: string;
}): Promise<ScenarioStepResult> {
  const stepId = safeStepId(input.step.id);
  const stepDir = join(input.runDir, 'steps', stepId);
  const startedAt = new Date().toISOString();
  const completedAt = startedAt;
  await mkdir(stepDir, { recursive: true });
  await input.dispatcher.emit({
    type: 'step.started',
    stepId,
    payload: {
      stepId,
      originalStepId: input.step.id,
      stepIndex: input.stepIndex,
      prompt: input.step.prompt,
      status: 'skipped',
      reason: input.reason,
    },
  });
  await input.dispatcher.emit({ type: 'step.stdout', stepId, payload: '' });
  await input.dispatcher.emit({ type: 'step.stderr', stepId, payload: '' });
  const cost = missingCostReport('step_skipped', costDimensions(input.entry, input.context, input.step, input.stepIndex, stepId));
  const events: ScenarioStepResult['events'] = { finalOutput: '', toolCalls: [], errors: [], cost };
  await input.dispatcher.emit({ type: 'step.events', stepId, payload: events });
  await input.dispatcher.emit({ type: 'step.cost', stepId, payload: cost });
  const assertions: ScenarioStepResult['assertions'] = [];
  await input.dispatcher.emit({ type: 'step.assertions', stepId, payload: assertions });
  const score = buildScoreSummary(input.scoring, { assertions, durationMs: 0, cost });
  await input.dispatcher.emit({ type: 'step.score', stepId, payload: score });
  const workspace = diffWorkspace(input.beforeSnapshot, await snapshotWorkspace(input.workspaceDir, input.entry.workspace.ignore));
  const result: ScenarioStepResult = {
    id: stepId,
    originalStepId: input.step.id,
    stepIndex: input.stepIndex,
    status: 'skipped',
    pass: false,
    exitCode: null,
    durationMs: 0,
    output: '',
    stdout: '',
    stderr: '',
    events,
    cost,
    assertions,
    score,
    workspace,
    startedAt,
    completedAt,
    error: input.reason,
    metadata: {
      caseId: input.entry.testCase.id,
      agentName: input.entry.agentName,
      runDir: input.runDir,
      step: { id: stepId, originalStepId: input.step.id, stepIndex: input.stepIndex, status: 'skipped' },
      skipReason: input.reason,
      workspace,
    },
  };
  await input.dispatcher.emit({ type: 'step.completed', stepId, payload: buildStepCompletedPayload(result) });
  return result;
}

function mergeStepAgentConfig(agent: MatrixEntry['agent'], step: MatrixEntry['testCase']['steps'][number]): MatrixEntry['agent'] {
  return {
    ...agent,
    args: step.args ? [...(agent.args ?? []), ...step.args] : agent.args ? [...agent.args] : undefined,
    env: step.env ? unique([...(agent.env ?? []), ...step.env]) : agent.env ? [...agent.env] : undefined,
    config: agent.config || step.config ? { ...(agent.config ?? {}), ...(step.config ?? {}) } : undefined,
  };
}

function buildStepMetadata(input: {
  entry: MatrixEntry;
  context: ScenarioRunContext;
  step: MatrixEntry['testCase']['steps'][number];
  stepIndex: number;
  stepId: string;
  stepDir: string;
  plan: AgentStepRunPlan;
  docker: Awaited<ReturnType<typeof runInDocker>>;
  events: ScenarioStepResult['events'];
  output: string;
  workspace: ScenarioStepResult['workspace'];
  status: ScenarioStepStatus;
  startedAt: string;
  completedAt: string;
  redactions: readonly Redaction[];
  mockCalls: readonly MockCallRecord[];
}): Record<string, unknown> {
  return redactJson({
    caseId: input.entry.testCase.id,
    scenarioId: input.context.scenarioId,
    agentName: input.entry.agentName,
    runId: input.context.runId,
    runDir: input.context.runDir,
    step: {
      id: input.stepId,
      originalStepId: input.step.id,
      stepIndex: input.stepIndex,
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    },
    ...(input.plan.metadata ?? {}),
    mocks: buildMockMetadata(input.plan, input.mockCalls),
    agent: {
      adapter: input.entry.agent.adapter,
      argv: input.docker.argv,
      exitCode: input.docker.exitCode,
      durationMs: input.docker.durationMs,
    },
    docker: {
      image: input.docker.image,
      command: input.docker.command,
      timedOut: input.docker.timedOut,
    },
    continuation: input.plan.continuation,
    events: {
      finalOutput: input.output,
      toolCalls: input.events.toolCalls,
      mockCalls: input.events.mockCalls ?? [],
      errors: input.events.errors,
      cost: input.events.cost,
      summaryPath: join(input.stepDir, 'events-summary.json'),
    },
    artifacts: {
      stdoutPath: join(input.stepDir, 'stdout.log'),
      stderrPath: join(input.stepDir, 'stderr.log'),
      commandPath: join(input.stepDir, 'command.redacted.json'),
    },
    workspace: input.workspace,
  }, input.redactions) as Record<string, unknown>;
}

// When the runner streamed the output to its artifact file, emit a small
// reference instead of the (possibly huge, possibly truncated) string — the
// file provider then leaves the already-written artifact in place.
function streamPayload(
  docker: Awaited<ReturnType<typeof runInDocker>> | undefined,
  kind: 'stdout' | 'stderr',
  fallback: string,
): unknown {
  const path = kind === 'stdout' ? docker?.stdoutPath : docker?.stderrPath;
  if (!docker || !path) return fallback;
  return {
    streamed: true,
    file: `${kind}.log`,
    bytes: kind === 'stdout' ? docker.stdoutBytes : docker.stderrBytes,
    truncated: kind === 'stdout' ? docker.stdoutTruncated : docker.stderrTruncated,
  };
}

function buildStepCompletedPayload(result: ScenarioStepResult): Record<string, unknown> {
  return {
    stepId: result.id,
    originalStepId: result.originalStepId,
    stepIndex: result.stepIndex,
    status: result.status,
    pass: result.pass,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    error: result.error,
    score: result.score,
    cost: result.cost,
    assertions: {
      total: result.assertions.length,
      passed: result.assertions.filter((assertion) => assertion.pass || !assertion.required).length,
      failedRequired: result.assertions.filter((assertion) => !assertion.pass && assertion.required).length,
    },
    mockCalls: readMockSummary(result.metadata),
  };
}

function determineStepStatus(docker: Awaited<ReturnType<typeof runInDocker>>, assertions: ScenarioStepResult['assertions']): ScenarioStepStatus {
  if (docker.timedOut) return 'timeout';
  if (docker.errorMessage) return 'error';
  return requiredAssertionsPassed(assertions) ? 'passed' : 'failed';
}

function requiredAssertionsPassed(assertions: ScenarioStepResult['assertions']): boolean {
  return assertions.every((assertion) => assertion.pass || !assertion.required);
}

function skipReasonForStep(result: ScenarioStepResult): string | undefined {
  switch (result.status) {
    case 'failed':
      return `Skipped because required assertions failed in step ${result.originalStepId}`;
    case 'timeout':
      return `Skipped because step ${result.originalStepId} timed out`;
    case 'error':
      return `Skipped because step ${result.originalStepId} errored`;
    default:
      return undefined;
  }
}

async function runVerifierArtifacts(input: {
  entry: MatrixEntry;
  dispatcher: OutputDispatcher;
  runDir: string;
  baseWorkspaceDir: string;
  workspaceDir: string;
  configDir: string;
  dockerImage: string;
  projectRoot: string;
}): Promise<{ verifier?: VerifierRunResult; modelPatch?: ModelPatchArtifact; hiddenPatch?: HiddenPatchResult }> {
  const verifierConfig = input.entry.testCase.verifier;
  if (!verifierConfig) return {};

  let modelPatch: ModelPatchArtifact | undefined;
  let hiddenPatch: HiddenPatchResult | undefined;

  if (shouldCaptureModelPatch(verifierConfig)) {
    const captured = await captureModelPatch({
      baseWorkspaceDir: input.baseWorkspaceDir,
      workspaceDir: input.workspaceDir,
      outputPath: join(input.runDir, 'model.patch'),
    });
    modelPatch = captured.artifact;
    await input.dispatcher.emit({ type: 'workspace.modelPatch', payload: { ...modelPatch, content: captured.content } });
  }

  if (verifierConfig.hiddenPatch) {
    hiddenPatch = await applyHiddenPatch(input.workspaceDir, verifierConfig.hiddenPatch);
    await input.dispatcher.emit({ type: 'workspace.hiddenPatch', payload: hiddenPatch });
    if (!hiddenPatch.applied) {
      const verifier = verifierSetupError(hiddenPatch.error ?? 'Hidden patch failed to apply');
      await input.dispatcher.emit({ type: 'verifier.completed', payload: verifier });
      return { verifier, modelPatch, hiddenPatch };
    }
  }

  await input.dispatcher.emit({
    type: 'verifier.started',
    payload: {
      command: verifierConfig.command,
      args: verifierConfig.args ?? [],
      rewardFile: verifierConfig.rewardFile,
      rewardFormat: verifierConfig.rewardFormat,
      network: verifierConfig.network ?? { mode: 'none' },
    },
  });
  const verifier = await runVerifier({
    verifier: verifierConfig,
    dockerImage: input.dockerImage,
    workspaceDir: input.workspaceDir,
    configDir: input.configDir,
    workspace: input.entry.workspace,
    docker: input.entry.docker,
    projectRoot: input.projectRoot,
    caseId: input.entry.testCase.id,
    agentName: input.entry.agentName,
  });
  if (verifier.command) await input.dispatcher.emit({ type: 'verifier.command', payload: verifier.command });
  await input.dispatcher.emit({ type: 'verifier.stdout', payload: verifier.stdout });
  await input.dispatcher.emit({ type: 'verifier.stderr', payload: verifier.stderr });
  if (verifier.reward) await input.dispatcher.emit({ type: 'verifier.reward', payload: verifier.reward });
  await input.dispatcher.emit({ type: 'verifier.completed', payload: verifier });

  return { verifier, modelPatch, hiddenPatch };
}

function buildTestRunResult(input: {
  entry: MatrixEntry;
  context: ScenarioRunContext;
  steps: ScenarioStepResult[];
  workspace: ScenarioStepResult['workspace'];
  verifier?: VerifierRunResult;
  modelPatch?: ModelPatchArtifact;
  hiddenPatch?: HiddenPatchResult;
  durationMs: number;
  scoring: ProjectScoringConfig;
  redactions: readonly Redaction[];
}): TestRunResult {
  const status = buildRunStatus(input.steps, input.verifier);
  const assertions = input.steps.flatMap((step) => step.assertions);
  const events = combineStepEvents(input.steps);
  const score = buildScenarioScoreSummary(input.scoring, input.steps, input.verifier);
  const cost = buildScenarioCostSummary(input.entry, input.context, input.steps);
  const mockCalls = input.steps.flatMap((step) => readMockCalls(step.metadata));
  const lastExecuted = [...input.steps].reverse().find((step) => step.status !== 'skipped');
  const firstError = input.steps.find((step) => step.status === 'error' || step.status === 'timeout')?.error ?? input.verifier?.error;

  return {
    caseId: input.entry.testCase.id,
    scenarioId: input.context.scenarioId,
    agentName: input.entry.agentName,
    suite: input.entry.testCase.suite,
    description: input.entry.testCase.description,
    runId: input.context.runId,
    attemptIndex: input.entry.attemptIndex,
    attemptNumber: input.entry.attemptNumber,
    attempts: input.entry.attempts,
    status,
    pass: status === 'passed',
    exitCode: lastExecuted?.exitCode ?? null,
    durationMs: input.durationMs,
    output: lastExecuted?.output ?? '',
    runDir: input.context.runDir,
    steps: input.steps,
    assertions,
    score,
    events,
    cost,
    workspace: input.workspace,
    verifier: input.verifier,
    modelPatch: input.modelPatch,
    hiddenPatch: input.hiddenPatch,
    error: firstError,
    metadata: redactJson({
      caseId: input.entry.testCase.id,
      scenarioId: input.context.scenarioId,
      agentName: input.entry.agentName,
      runId: input.context.runId,
      runDir: input.context.runDir,
      status,
      provider: input.entry.agent.provider,
      model: input.entry.agent.model,
      attempt: {
        index: input.entry.attemptIndex,
        number: input.entry.attemptNumber,
        total: input.entry.attempts,
      },
      score,
      cost,
      stepCount: input.steps.length,
      verifier: input.verifier,
      modelPatch: input.modelPatch,
      hiddenPatch: input.hiddenPatch,
      mockCalls: {
        calls: mockCalls,
        summary: summarizeMockCalls(mockCalls),
      },
      steps: input.steps.map((step) => ({
        id: step.id,
        originalStepId: step.originalStepId,
        stepIndex: step.stepIndex,
        status: step.status,
        pass: step.pass,
        durationMs: step.durationMs,
        error: step.error,
        cost: step.cost,
        mockCalls: readMockSummary(step.metadata),
      })),
      workspace: input.workspace,
    }, input.redactions) as Record<string, unknown>,
  };
}

function buildSetupErrorResult(
  entry: MatrixEntry,
  runId: string,
  runDir: string,
  steps: ScenarioStepResult[],
  message: string,
  durationMs: number,
  redactions: readonly Redaction[],
  scoring: ProjectScoringConfig,
): TestRunResult {
  const setupAssertion = errorAssertion(message);
  const assertions = [...steps.flatMap((step) => step.assertions), setupAssertion];
  const events = combineStepEvents(steps);
  events.errors.push(message);
  const score = buildScoreSummary(scoring, { assertions, durationMs, cost: events.cost });
  const lastStep = steps.at(-1);
  const cost = buildCostSummary({
    entries: steps.map((step) => stepCostEntry(entry, step, runId)),
    testCaseId: entry.testCase.id,
    scenarioId: entry.testCase.id,
    agentName: entry.agentName,
    runId,
    metadata: { setupError: true },
  });

  return {
    caseId: entry.testCase.id,
    scenarioId: entry.testCase.id,
    agentName: entry.agentName,
    suite: entry.testCase.suite,
    description: entry.testCase.description,
    runId,
    attemptIndex: entry.attemptIndex,
    attemptNumber: entry.attemptNumber,
    attempts: entry.attempts,
    status: 'error',
    pass: false,
    exitCode: lastStep?.exitCode ?? null,
    durationMs,
    output: lastStep?.output ?? '',
    runDir,
    steps,
    assertions,
    score,
    events,
    cost,
    workspace: lastStep?.workspace ?? emptyWorkspaceDiff(),
    error: message,
    metadata: redactJson({
      caseId: entry.testCase.id,
      scenarioId: entry.testCase.id,
      agentName: entry.agentName,
      runId,
      runDir,
      status: 'error',
      provider: entry.agent.provider,
      model: entry.agent.model,
      attempt: {
        index: entry.attemptIndex,
        number: entry.attemptNumber,
        total: entry.attempts,
      },
      setupError: message,
      score,
      cost,
      stepCount: steps.length,
    }, redactions) as Record<string, unknown>,
  };
}

function buildRunStatus(steps: ScenarioStepResult[], verifier?: VerifierRunResult): ScenarioRunStatus {
  if (steps.length === 0) return 'error';
  if (steps.some((step) => step.status === 'error')) return 'error';
  if (steps.some((step) => step.status === 'timeout')) return 'timeout';
  if (verifier?.status === 'error') return 'error';
  if (verifier?.status === 'timeout') return 'timeout';
  if (verifier && !verifier.pass) return 'failed';
  if (steps.every((step) => step.status === 'passed')) return 'passed';
  return 'failed';
}

function combineStepEvents(steps: ScenarioStepResult[]): ScenarioStepResult['events'] {
  const executed = steps.filter((step) => step.status !== 'skipped');
  const lastExecuted = executed.at(-1);
  const events: ScenarioStepResult['events'] = {
    finalOutput: lastExecuted?.output ?? '',
    toolCalls: executed.flatMap((step) => step.events.toolCalls),
    errors: executed.flatMap((step) => step.events.errors),
  };
  const mockCalls = executed.flatMap((step) => step.events.mockCalls ?? []);
  if (mockCalls.length > 0) events.mockCalls = mockCalls;
  const cost = mergeCostReports(executed.map((step) => step.cost));
  if (cost) events.cost = cost;
  return events;
}

function outputStatusForRun(status: ScenarioRunStatus): 'passed' | 'failed' | 'error' {
  if (status === 'passed') return 'passed';
  if (status === 'error') return 'error';
  return 'failed';
}

function emptyWorkspaceDiff(): ScenarioStepResult['workspace'] {
  return { added: [], changed: [], deleted: [] };
}

function errorAssertion(message: string): ScenarioStepResult['assertions'][number] {
  return { type: 'error', pass: false, reason: message, required: true, score: 0 };
}

function costDimensions(
  entry: MatrixEntry,
  context: ScenarioRunContext,
  step: MatrixEntry['testCase']['steps'][number],
  stepIndex: number,
  stepId: string,
): CostDimensions {
  return {
    stepId,
    stepKey: stepId,
    originalStepId: step.id,
    stepIndex,
    testCaseId: entry.testCase.id,
    scenarioId: context.scenarioId,
    agentName: entry.agentName,
    runId: context.runId,
    provider: entry.agent.provider,
    model: entry.agent.model,
    source: 'agent',
  };
}

function stepCostEntry(entry: MatrixEntry, step: ScenarioStepResult, runId: string): CostReportEntry {
  return {
    report: step.cost,
    stepId: step.id,
    stepKey: step.id,
    originalStepId: step.originalStepId,
    stepIndex: step.stepIndex,
    testCaseId: entry.testCase.id,
    scenarioId: entry.testCase.id,
    agentName: entry.agentName,
    runId,
    provider: entry.agent.provider,
    model: entry.agent.model,
    source: 'agent',
  };
}

function buildScenarioCostSummary(entry: MatrixEntry, context: ScenarioRunContext, steps: ScenarioStepResult[]): CostSummary {
  return buildCostSummary({
    entries: steps.map((step) => stepCostEntry(entry, step, context.runId)),
    testCaseId: entry.testCase.id,
    scenarioId: context.scenarioId,
    agentName: entry.agentName,
    runId: context.runId,
  });
}

function buildHarnessCostSummary(results: TestRunResult[]): CostSummary {
  const entries = results.flatMap((result) => result.steps.map((step): CostReportEntry => ({
    report: step.cost,
    stepId: step.id,
    stepKey: step.id,
    originalStepId: step.originalStepId,
    stepIndex: step.stepIndex,
    testCaseId: result.caseId,
    scenarioId: result.scenarioId,
    agentName: result.agentName,
    runId: result.runId,
    source: 'agent',
  })));

  return buildCostSummary({ entries, metadata: { resultCount: results.length } });
}

function buildPassAtKSummary(results: TestRunResult[]): PassAtKSummary[] {
  const groups = new Map<string, TestRunResult[]>();
  for (const result of results) {
    const key = [result.caseId, result.agentName, readString(result.metadata.provider), readString(result.metadata.model)].join('\0');
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }

  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((a, b) => a.attemptNumber - b.attemptNumber);
    const first = ordered[0];
    const eligibility = passAtKEligibility(ordered);
    const successes = eligibility.eligible ? ordered.filter((result) => result.verifier?.reward?.primary === 1).length : 0;
    const attempts = ordered.length;
    return {
      caseId: first.caseId,
      scenarioId: first.scenarioId,
      agentName: first.agentName,
      provider: readString(first.metadata.provider),
      model: readString(first.metadata.model),
      attempts,
      successes,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      values: eligibility.eligible ? passAtKValues(attempts, successes) : {},
    };
  });
}

function passAtKEligibility(results: TestRunResult[]): { eligible: boolean; reason?: string } {
  if (results.length <= 1) return { eligible: false, reason: 'pass@k requires multiple attempts' };
  let rewardCount = 0;
  for (const result of results) {
    const reward = result.verifier?.reward;
    if (!reward) continue;
    rewardCount += 1;
    const values = Object.values(reward.values);
    if (values.length !== 1 || !reward.binary) return { eligible: false, reason: 'expected exactly one binary verifier reward per attempt' };
  }
  if (rewardCount === 0) return { eligible: false, reason: 'missing verifier rewards' };
  return { eligible: true };
}

function passAtKValues(attempts: number, successes: number): Record<string, number> {
  const values: Record<string, number> = {};
  for (let k = 1; k <= attempts; k++) {
    values[`pass@${k}`] = passAtK(attempts, successes, k);
  }
  return values;
}

function passAtK(attempts: number, successes: number, k: number): number {
  if (successes <= 0) return 0;
  if (attempts - successes < k) return 1;
  let probabilityAllFail = 1;
  for (let i = 0; i < k; i++) {
    probabilityAllFail *= (attempts - successes - i) / (attempts - i);
  }
  return Math.round((1 - probabilityAllFail) * 1_000_000) / 1_000_000;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface VisualizationReportPayload {
  status: 'rendered';
  runId: string;
  scope: 'run' | 'latest';
  latest: boolean;
  formats: Array<'html' | 'json' | 'csv'>;
  files: Array<{ format: 'html' | 'json' | 'csv'; path: string }>;
}

function runVisualizationReportPayload(config: LoadedHarnessConfig, result: TestRunResult): VisualizationReportPayload | undefined {
  if (!hasFileVisualization(config) || !config.visualization.formats.includes('html')) return undefined;
  return {
    status: 'rendered',
    runId: result.runId,
    scope: 'run',
    latest: false,
    formats: ['html'],
    files: [{ format: 'html', path: join(result.runDir, 'index.html') }],
  };
}

function latestVisualizationReportPayload(config: LoadedHarnessConfig, runId: string): VisualizationReportPayload | undefined {
  if (!hasFileVisualization(config) || !config.visualization.latest || config.visualization.formats.length === 0) return undefined;
  return {
    status: 'rendered',
    runId,
    scope: 'latest',
    latest: true,
    formats: [...config.visualization.formats],
    files: config.visualization.formats.map((format) => ({
      format,
      path: join(config.outputRoot, 'latest', `results.${format}`),
    })),
  };
}

function hasFileVisualization(config: LoadedHarnessConfig): boolean {
  return config.visualization.enabled && config.output.providers.some((provider) => provider.type === 'file');
}

async function writeHarnessSummary(
  config: LoadedHarnessConfig,
  outputRegistry: OutputProviderRegistry,
  registry: AdapterRegistry,
  matrix: MatrixEntry[],
  results: TestRunResult[],
  cost: CostSummary,
  passAtK: PassAtKSummary[],
  batch?: BatchInfo,
): Promise<string> {
  const runId = `summary-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const redactions = redactionsFromEnv(unique(matrix.flatMap((entry) => runRedactionEnvNames(config, entry, registry))));
  const dispatcher = await createOutputDispatcher({
    projectRoot: config.projectRoot,
    runId,
    redactions,
    providers: outputRegistry.create({ runId }),
  });
  const pass = results.every((result) => result.pass);
  await dispatcher.emit({
    type: 'run.summary',
    payload: {
      pass,
      results,
      cost,
      passAtK,
      batch,
      providerFailures: dispatcher.providerFailures,
    },
  });
  const latestVisualization = latestVisualizationReportPayload(config, runId);
  if (latestVisualization) await dispatcher.emit({ type: 'visualization.report', payload: latestVisualization });
  await dispatcher.finalize({ status: pass ? 'passed' : 'failed' });
  return latestVisualization?.files.find((file) => file.format === 'json')?.path ?? join(config.outputRoot, 'latest', 'results.json');
}

async function persistErrorResult(config: LoadedHarnessConfig, dispatcher: OutputDispatcher, result: TestRunResult, stepId: string | undefined, batch?: BatchInfo): Promise<void> {
  try {
    if (stepId) {
      await dispatcher.emit({
        type: 'step.completed',
        stepId,
        payload: {
          stepId,
          status: 'error',
          pass: false,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          error: result.error,
        },
      });
    }
    await dispatcher.emit({ type: 'scenario.scoreSummary', payload: result.score });
    await dispatcher.emit({ type: 'scenario.costSummary', payload: result.cost });
    await dispatcher.emit({ type: 'run.result', payload: result });
    const runVisualization = runVisualizationReportPayload(config, result);
    if (runVisualization) await dispatcher.emit({ type: 'visualization.report', payload: runVisualization });
    await dispatcher.emit({ type: 'run.summary', payload: buildRunSummary(result, dispatcher, batch) });
    await dispatcher.finalize({ status: 'error' });
  } catch (outputError) {
    const outputMessage = outputError instanceof Error ? outputError.message : String(outputError);
    result.error = `${result.error}; output persistence failed: ${outputMessage}`;
    result.events.errors.push(outputMessage);
  }
}

function buildRunSummary(result: TestRunResult, dispatcher: OutputDispatcher, batch?: BatchInfo): Record<string, unknown> {
  return {
    caseId: result.caseId,
    scenarioId: result.scenarioId,
    agentName: result.agentName,
    batchId: batch?.batchId,
    suite: result.suite,
    description: result.description,
    attemptIndex: result.attemptIndex,
    attemptNumber: result.attemptNumber,
    attempts: result.attempts,
    status: result.status,
    pass: result.pass,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    runDir: result.runDir,
    error: result.error,
    score: result.score,
    cost: result.cost,
    verifier: result.verifier,
    modelPatch: result.modelPatch,
    hiddenPatch: result.hiddenPatch,
    steps: result.steps.map((step) => ({
      id: step.id,
      originalStepId: step.originalStepId,
      stepIndex: step.stepIndex,
      status: step.status,
      pass: step.pass,
      durationMs: step.durationMs,
      score: step.score,
      cost: step.cost,
      error: step.error,
      mockCalls: readMockSummary(step.metadata),
    })),
    assertions: {
      total: result.assertions.length,
      passed: result.assertions.filter((assertion) => assertion.pass || !assertion.required).length,
      failedRequired: result.assertions.filter((assertion) => !assertion.pass && assertion.required).length,
    },
    mockCalls: readMockSummary(result.metadata),
    providerFailures: dispatcher.providerFailures,
  };
}

async function createRunAdapterRegistry(config: LoadedHarnessConfig, extraAdapters: AgentAdapter[] = []): Promise<AdapterRegistry> {
  return createAdapterRegistry({
    projectRoot: config.projectRoot,
    declarations: config.adapters,
    builtIns: [...builtInAdapters, ...extraAdapters],
  });
}

async function resolveAndEmitImage(input: {
  config: LoadedHarnessConfig;
  entry: MatrixEntry;
  adapterRegistry: AdapterRegistry;
  dispatcher: OutputDispatcher;
  imageAgents: ImageResolutionAgent[];
  refreshManagedImage?: boolean;
  resolveImage?: () => Promise<ImageResolutionResult>;
}) {
  try {
    const resolution = input.resolveImage
      ? await input.resolveImage()
      : await resolveDockerImage({
        projectRoot: input.config.projectRoot,
        docker: input.entry.docker,
        selectedAgents: input.imageAgents,
        adapterRegistry: input.adapterRegistry,
        refreshManagedImage: input.refreshManagedImage,
      });
    await input.dispatcher.emit({ type: 'image.resolution', payload: resolution });
    return resolution;
  } catch (error) {
    if (error instanceof ImageResolutionError && error.resolution) {
      await input.dispatcher.emit({ type: 'image.resolution', payload: error.resolution });
    }
    throw error;
  }
}

function buildImageResolutionAgents(matrix: MatrixEntry[]): ImageResolutionAgent[] {
  return matrix.map((entry) => ({ agentName: entry.agentName, agent: entry.agent }));
}

function runRedactionEnvNames(config: LoadedHarnessConfig, entry: MatrixEntry, registry: AdapterRegistry): string[] {
  return unique([
    ...entry.docker.envAllowlist,
    ...(entry.agent.envAllowlist ?? []),
    ...(entry.agent.env ?? []),
    ...(entry.testCase.verifier?.env ?? []),
    ...entry.testCase.steps.flatMap((step) => step.env ?? []),
    entry.agent.apiKeyEnv,
    ...adapterAuthEnvNames(registry, entry.agent.adapter),
    ...judgeApiKeyEnvNames(config, entry.testCase),
  ]);
}

function adapterAuthEnvNames(registry: AdapterRegistry, adapterName: string): string[] {
  return [...(registry.require(adapterName).authEnvNames ?? [])];
}

function judgeApiKeyEnvNames(config: LoadedHarnessConfig, testCase: MatrixEntry['testCase']): string[] {
  const names = new Set<string>();
  for (const step of testCase.steps) {
    for (const assertion of step.assert) {
      if (assertion.type !== 'llmJudge') continue;
      const judge = readRecord(assertion.judge);
      const apiKeyEnv = typeof judge?.apiKeyEnv === 'string' ? judge.apiKeyEnv : config.judge?.apiKeyEnv;
      if (apiKeyEnv) names.add(apiKeyEnv);
    }
  }
  return [...names];
}

function summarizeMockCallRecords(calls: readonly MockCallRecord[]): MockCallSummary[] {
  return calls.map((call) => ({
    surface: call.surface,
    name: call.tool,
    args: call.input,
    result: { exitCode: call.exitCode, matched: call.matched, ruleId: call.ruleId },
    fixture: call.fixtureName ?? call.fixturePath,
    matched: call.matched,
    isError: Boolean(call.error) || (call.strict && !call.matched),
    metadata: {
      command: call.command,
      serverName: call.serverName,
      tool: call.tool,
      ruleId: call.ruleId,
      fixturePath: call.fixturePath,
      exitCode: call.exitCode,
      error: call.error,
    },
  }));
}

function buildMockMetadata(plan: AgentStepRunPlan | undefined, calls: readonly MockCallRecord[]): Record<string, unknown> | undefined {
  const existing = readRecord(plan?.metadata?.mocks);
  if (!existing && calls.length === 0) return undefined;
  return {
    ...(existing ?? {}),
    calls,
    summary: summarizeMockCalls(calls),
  };
}

function readMockSummary(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const mocks = readRecord(metadata.mocks);
  return readRecord(mocks?.summary);
}

function readMockCalls(metadata: Record<string, unknown>): MockCallRecord[] {
  const mocks = readRecord(metadata.mocks);
  const calls = mocks?.calls;
  return Array.isArray(calls) ? calls as MockCallRecord[] : [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasMcpMocks(mocks: MatrixEntry['testCase']['mocks']): boolean {
  return Boolean(mocks?.mcp && Object.keys(mocks.mcp).length > 0);
}

function hasDeclaredMcpMocks(entry: MatrixEntry): boolean {
  return hasMcpMocks(entry.testCase.mocks) || entry.testCase.steps.some((step) => hasMcpMocks(step.mocks));
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
