export type WorkspaceMode = 'copy';

export interface WorkspaceConfig {
  source: string;
  mode: WorkspaceMode;
  containerPath: string;
  ignore: string[];
  fixture?: string;
}

export interface DockerConfig {
  image?: string;
  repoPath: string;
  home: string;
  configRoot: string;
  timeoutMs: number;
  envAllowlist: string[];
}

export interface AgentConfig {
  adapter: string;
  extends?: string;
  label?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: string[];
  envAllowlist?: string[];
  timeoutMs?: number;
  provider?: string;
  providerEnv?: string;
  model?: string;
  modelEnv?: string;
  apiKeyEnv?: string;
  profile?: string;
  outputFormat?: string;
  useCurrentConfig?: boolean;
  projectConfigDirs?: string[];
  userConfigDirs?: string[];
  config?: Record<string, unknown>;
  parser?: string;
}

export interface AgentsSelection {
  include?: string[];
  exclude?: string[];
  overrides?: Record<string, Partial<AgentConfig>>;
}

export interface AdapterDeclaration {
  module: string;
  export?: string;
}

export interface MockConfig {
  root: string;
  strict: boolean;
  recordCalls: boolean;
}

export interface TestCaseMockConfig {
  cli?: Record<string, string>;
  mcp?: Record<string, string>;
  strict?: boolean;
}

export interface OutputProviderConfig {
  type: string;
  module?: string;
  export?: string;
  config?: Record<string, unknown>;
}

export interface OutputConfig {
  providers: OutputProviderConfig[];
}

export type VisualizationFormat = 'html' | 'json' | 'csv';

export interface VisualizationIncludeConfig {
  logs: boolean;
  workspaceDiff: boolean;
  toolCalls: boolean;
  mockCalls: boolean;
  judgeDetails: boolean;
}

export interface VisualizationConfig {
  enabled: boolean;
  formats: VisualizationFormat[];
  latest: boolean;
  include: VisualizationIncludeConfig;
}

export interface JudgeDefaults {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  temperature?: number;
  promptTemplate?: string;
}

export type JudgeInputRef =
  | 'finalOutput'
  | 'stdout'
  | 'stderr'
  | 'events'
  | 'toolCalls'
  | 'mockCalls'
  | 'assertions'
  | 'workspaceDiff'
  | 'cost';

export interface JudgeAssertionDefinition extends Partial<JudgeDefaults> {
  rubric: string;
  inputs: JudgeInputRef[];
}

export interface BaseAssertionConfig {
  id?: string;
  type: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface LlmJudgeAssertionConfig extends BaseAssertionConfig {
  type: 'llmJudge';
  threshold: number;
  judge: JudgeAssertionDefinition;
}

export type AssertionConfig = BaseAssertionConfig | LlmJudgeAssertionConfig;

export type ScoreType = 'assertionPassRate' | 'judgeScore' | 'latency' | 'cost' | 'tokenUsage';
export type ScoreTarget = 'maximize' | 'minimize';

export interface ScoreTypeConfig {
  weight: number;
}

export interface MetricScoreConfig extends ScoreTypeConfig {
  target?: ScoreTarget;
  best?: number;
  worst?: number;
}

export type ProjectScoringConfig = Partial<Record<ScoreType, ScoreTypeConfig | MetricScoreConfig>>;

export interface TestCaseStepDefinition {
  id: string;
  prompt: string;
  timeoutMs?: number;
  args?: string[];
  env?: string[];
  config?: Record<string, unknown>;
  mocks?: TestCaseMockConfig;
  assert: AssertionConfig[];
}

export interface TestCaseDefinition {
  id: string;
  description?: string;
  suite?: string;
  workspace?: Partial<WorkspaceConfig>;
  agents?: AgentsSelection;
  mocks?: TestCaseMockConfig;
  steps: TestCaseStepDefinition[];
  timeoutMs?: number;
  sourcePath?: string;

  prompt: string;
  assert: AssertionConfig[];
  args?: string[];
  env?: string[];
  config?: Record<string, unknown>;
  parser?: string;
}

export type TestCase = TestCaseDefinition;

export interface HarnessConfig {
  version: 1;
  artifactRoot: string;
  outputRoot: string;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
  agents: Record<string, AgentConfig>;
  tests: string[];
  adapters: Record<string, AdapterDeclaration>;
  mocks: MockConfig;
  output: OutputConfig;
  visualization: VisualizationConfig;
  judge?: JudgeDefaults;
  scoring: ProjectScoringConfig;
}

export interface LoadedHarnessConfig extends HarnessConfig {
  projectRoot: string;
  configPath: string;
  testCases: TestCase[];
}

export interface CliOverrides {
  agents?: string[];
  caseId?: string;
  suite?: string;
  concurrency?: number;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  dockerImage?: string;
}

export interface MatrixEntry {
  testCase: TestCase;
  agentName: string;
  agent: AgentConfig;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
}

export const DEFAULT_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'AZURE_OPENAI_API_KEY',
];

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  version: 1,
  artifactRoot: '.harness-evals/runs',
  outputRoot: '.harness-evals/output',
  workspace: {
    source: '.',
    mode: 'copy',
    containerPath: '/workspace',
    ignore: ['.git', 'node_modules', '.harness-evals', '.pi-evals', 'evals/output'],
  },
  docker: {
    repoPath: '/workspace',
    home: '/home/harness',
    configRoot: '/agent-config',
    timeoutMs: 300_000,
    envAllowlist: DEFAULT_ENV_ALLOWLIST,
  },
  agents: {},
  tests: ['evals/tests/**/*.yaml'],
  adapters: {},
  mocks: {
    root: 'evals/mocks',
    strict: true,
    recordCalls: true,
  },
  output: {
    providers: [{ type: 'file' }],
  },
  visualization: {
    enabled: true,
    formats: ['html', 'json', 'csv'],
    latest: true,
    include: {
      logs: true,
      workspaceDiff: true,
      toolCalls: true,
      mockCalls: true,
      judgeDetails: true,
    },
  },
  scoring: {
    assertionPassRate: { weight: 1 },
    judgeScore: { weight: 1 },
    latency: { weight: 0 },
    cost: { weight: 0 },
    tokenUsage: { weight: 0 },
  },
};
