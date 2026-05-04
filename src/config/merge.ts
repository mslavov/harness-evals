import {
  DEFAULT_HARNESS_CONFIG,
  type AgentConfig,
  type DockerConfig,
  type HarnessConfig,
  type MockConfig,
  type OutputConfig,
  type ProjectScoringConfig,
  type VisualizationConfig,
  type WorkspaceConfig,
} from './schema.js';

type VisualizationConfigOverride = Omit<Partial<VisualizationConfig>, 'include'> & { include?: Partial<VisualizationConfig['include']> };

export interface HarnessConfigOverride extends Omit<Partial<HarnessConfig>, 'workspace' | 'docker' | 'agents' | 'tests' | 'mocks' | 'output' | 'visualization' | 'scoring'> {
  workspace?: Partial<WorkspaceConfig>;
  docker?: Partial<DockerConfig>;
  agents?: Record<string, AgentConfig>;
  tests?: string[];
  mocks?: Partial<MockConfig>;
  output?: Partial<OutputConfig>;
  visualization?: VisualizationConfigOverride;
  scoring?: ProjectScoringConfig;
}

export function mergeHarnessConfig(base: HarnessConfig, override: HarnessConfigOverride): HarnessConfig {
  return {
    ...base,
    ...definedObject(override),
    workspace: mergeWorkspaceConfig(base.workspace, override.workspace),
    docker: mergeDockerConfig(base.docker, override.docker),
    agents: mergeRecord(base.agents, override.agents),
    tests: override.tests ? [...override.tests] : [...base.tests],
    adapters: mergeRecord(base.adapters, override.adapters),
    mocks: mergeMockConfig(base.mocks, override.mocks),
    output: mergeOutputConfig(base.output, override.output),
    visualization: mergeVisualizationConfig(base.visualization, override.visualization),
    scoring: mergeScoringConfig(base.scoring, override.scoring),
  };
}

export function withHarnessDefaults(config: HarnessConfigOverride): HarnessConfig {
  return mergeHarnessConfig(DEFAULT_HARNESS_CONFIG, config);
}

export function mergeWorkspaceConfig(base: WorkspaceConfig, override?: Partial<WorkspaceConfig>): WorkspaceConfig {
  if (!override) return { ...base, ignore: [...base.ignore] };
  return {
    ...base,
    ...definedObject(override),
    ignore: override.ignore ? [...override.ignore] : [...base.ignore],
  };
}

export function mergeDockerConfig(base: DockerConfig, override?: Partial<DockerConfig>): DockerConfig {
  if (!override) return { ...base, envAllowlist: [...base.envAllowlist] };
  return {
    ...base,
    ...definedObject(override),
    envAllowlist: override.envAllowlist ? [...override.envAllowlist] : [...base.envAllowlist],
  };
}

export function mergeAgentConfig(base: AgentConfig, override?: Partial<AgentConfig>): AgentConfig {
  if (!override) return cloneAgentConfig(base);
  return {
    ...base,
    ...definedObject(override),
    args: override.args ?? base.args,
    env: override.env ?? base.env,
    envAllowlist: override.envAllowlist ?? base.envAllowlist,
    projectConfigDirs: override.projectConfigDirs ?? base.projectConfigDirs,
    userConfigDirs: override.userConfigDirs ?? base.userConfigDirs,
    config: mergeUnknownRecord(base.config, override.config),
  };
}

export function resolveAgentExtends(agents: Record<string, AgentConfig>): Record<string, AgentConfig> {
  const resolved: Record<string, AgentConfig> = {};
  const resolving = new Set<string>();

  const resolveOne = (name: string): AgentConfig => {
    if (resolved[name]) return resolved[name];
    const agent = agents[name];
    if (!agent) throw new Error(`Unknown agent: ${name}`);
    if (resolving.has(name)) throw new Error(`Circular agent extends chain at ${name}`);

    resolving.add(name);
    const parent = agent.extends ? resolveOne(agent.extends) : undefined;
    const merged = parent ? mergeAgentConfig(parent, agent) : cloneAgentConfig(agent);
    delete merged.extends;
    resolving.delete(name);
    resolved[name] = merged;
    return merged;
  };

  for (const name of Object.keys(agents)) {
    resolveOne(name);
  }

  return resolved;
}

function mergeMockConfig(base: MockConfig, override?: Partial<MockConfig>): MockConfig {
  return { ...base, ...definedObject(override) };
}

function mergeOutputConfig(base: OutputConfig, override?: Partial<OutputConfig>): OutputConfig {
  return {
    providers: override?.providers ? [...override.providers] : [...base.providers],
  };
}

function mergeVisualizationConfig(
  base: VisualizationConfig,
  override?: VisualizationConfigOverride,
): VisualizationConfig {
  if (!override) return cloneVisualizationConfig(base);
  return {
    ...base,
    ...definedObject(override),
    formats: override.formats ? [...override.formats] : [...base.formats],
    include: { ...base.include, ...(override.include ?? {}) },
  };
}

function mergeScoringConfig(base: ProjectScoringConfig, override?: ProjectScoringConfig): ProjectScoringConfig {
  if (!override) return cloneScoringConfig(base);
  const merged: ProjectScoringConfig = cloneScoringConfig(base);
  for (const key of Object.keys(override) as Array<keyof ProjectScoringConfig>) {
    merged[key] = { ...(base[key] ?? {}), ...(override[key] ?? {}) } as ProjectScoringConfig[typeof key];
  }
  return merged;
}

function mergeRecord<T>(base: Record<string, T>, override?: Record<string, T>): Record<string, T> {
  return { ...base, ...(override ?? {}) };
}

function mergeUnknownRecord(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function cloneAgentConfig(agent: AgentConfig): AgentConfig {
  return {
    ...agent,
    args: agent.args ? [...agent.args] : undefined,
    env: agent.env ? [...agent.env] : undefined,
    envAllowlist: agent.envAllowlist ? [...agent.envAllowlist] : undefined,
    projectConfigDirs: agent.projectConfigDirs ? [...agent.projectConfigDirs] : undefined,
    userConfigDirs: agent.userConfigDirs ? [...agent.userConfigDirs] : undefined,
    config: agent.config ? { ...agent.config } : undefined,
  };
}

function cloneVisualizationConfig(config: VisualizationConfig): VisualizationConfig {
  return {
    ...config,
    formats: [...config.formats],
    include: { ...config.include },
  };
}

function cloneScoringConfig(config: ProjectScoringConfig): ProjectScoringConfig {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value ? { ...value } : value])) as ProjectScoringConfig;
}

function definedObject<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as Partial<T>;
}
