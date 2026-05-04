export type WorkspaceMode = 'copy';

export interface WorkspaceConfig {
  source: string;
  mode: WorkspaceMode;
  containerPath: string;
  ignore: string[];
  fixture?: string;
}

export interface DockerConfig {
  image: string;
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

export interface AssertionConfig {
  type: string;
  [key: string]: unknown;
}

export interface TestCase {
  id: string;
  description?: string;
  suite?: string;
  agents?: AgentsSelection;
  workspace?: Partial<WorkspaceConfig>;
  prompt: string;
  assert: AssertionConfig[];
  timeoutMs?: number;
  args?: string[];
  env?: string[];
  config?: Record<string, unknown>;
  parser?: string;
  sourcePath?: string;
}

export interface TestReference {
  file?: string;
  builtin?: string;
  suite?: string;
}

export interface HarnessConfig {
  version: 1;
  artifactRoot: string;
  outputRoot: string;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
  agents: Record<string, AgentConfig>;
  tests: TestReference[];
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
  'PI_EVAL_PROVIDER',
  'PI_EVAL_MODEL',
  'PI_EVAL_API_KEY',
  'PI_EVAL_A_API_KEY',
  'PI_EVAL_B_API_KEY',
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
    image: 'oven/bun:1.2.10',
    repoPath: '/workspace',
    home: '/home/harness',
    configRoot: '/agent-config',
    timeoutMs: 300_000,
    envAllowlist: DEFAULT_ENV_ALLOWLIST,
  },
  agents: {},
  tests: [],
};
