export { loadHarnessConfig, type LoadHarnessConfigOptions } from './config/load.js';
export { runHarness, runTestCase, type RunHarnessOptions } from './runner/evaluate.js';
export { buildMatrix } from './runner/matrix.js';
export {
  ImageResolutionError,
  resolveDockerImage,
  type ImageMode,
  type ImageResolutionAgent,
  type ImageResolutionInput,
  type ImageResolutionResult,
  type InstallManifest,
  type NormalizedInstallRecipe,
  type ProbeResult,
} from './docker/image-resolver.js';
export {
  createAdapterRegistry,
  validateAdapterContract,
  validateAdapterReferences,
  builtInAdapters,
  type AdapterRegistry,
  type AdapterRegistryInput,
  type AgentAdapterMetadata,
} from './adapters/registry.js';
export {
  type AgentAdapter,
  type AgentCompletionInput,
  type AgentEventInput,
  type AgentStepPrepareInput,
  type AgentStepRunPlan,
  type AdapterInstallInput,
  type AdapterInstallRecipe,
  type AdapterProbe,
  type ApplyMcpMocksInput,
  type ApplyMcpMocksResult,
  type AdapterContinuation,
  type MockRuntimePlan,
} from './adapters/types.js';
export { commandAdapter } from './adapters/command.js';
export { piAdapter } from './adapters/pi.js';
export { claudeCodeAdapter } from './adapters/claude-code.js';
export { codexAdapter } from './adapters/codex.js';
export { cursorAdapter } from './adapters/cursor.js';
export { builtInAssertions, runAssertions } from './assertions/builtins.js';
export type { AssertionContext, AssertionResult, AssertionRunner, AssertionRunOptions } from './assertions/types.js';
export { createConfiguredJudgeRunner, defaultJudgeRunner } from './judge/index.js';
export type { JudgeRecord, JudgeRequest, JudgeResult, JudgeRunner } from './judge/index.js';
export { buildScenarioScoreSummary, buildScoreSummary } from './scoring/index.js';
export type { ScoreBucketResult, ScoreSummary } from './scoring/index.js';
export { readMockCallLogs, strictMockFailures, summarizeMockCalls } from './mocks/calls.js';
export { mergeMockDeclarations, stageMockRuntime } from './mocks/stage.js';
export type { MockCallRecord, MockFixture, MockRule, MockSurface } from './mocks/types.js';
export type {
  HarnessConfig,
  LoadedHarnessConfig,
  AgentConfig,
  TestCase,
  TestCaseDefinition,
  TestCaseStepDefinition,
  AssertionConfig,
  AdapterDeclaration,
  MockConfig,
  TestCaseMockConfig,
  TestCaseVerifierConfig,
  VerifierRewardFormat,
  NetworkPolicyConfig,
  NetworkPolicyMode,
  OutputConfig,
  OutputProviderConfig,
  VisualizationConfig,
  JudgeDefaults,
  ProjectScoringConfig,
  MatrixEntry,
} from './config/schema.js';
export type { HarnessRunResult, PassAtKSummary, ScenarioRunContext, ScenarioRunStatus, ScenarioStepResult, ScenarioStepStatus, TestRunResult } from './runner/result.js';
export type { HiddenPatchResult, ModelPatchArtifact, VerifierRewardResult, VerifierRunResult, VerifierStatus } from './verifier/types.js';
export type { WorkspaceDiff } from './workspace/diff.js';
export type { AgentEventsSummary, ToolCallSummary, MockCallSummary, CostReport, CostRollup, UsageReport } from './events/types.js';
export {
  createOutputDispatcher,
  OutputDispatcher,
  createFileOutputProvider,
  createOutputProviderRegistry,
  validateOutputProviderContract,
  type ConfiguredOutputProvider,
  type CreateOutputDispatcherInput,
  type CreateOutputProvidersInput,
  type FileOutputProviderOptions,
  type OutputBlob,
  type OutputBlobRef,
  type OutputFinalizeInput,
  type OutputProvider,
  type OutputProviderFactory,
  type OutputProviderFailure,
  type OutputProviderInitializeInput,
  type OutputProviderMetadata,
  type OutputProviderRegistry,
  type OutputProviderRegistryInput,
  type OutputRecord,
  type OutputRecordInput,
  type OutputRecordType,
  type OutputRunStatus,
} from './output/index.js';
