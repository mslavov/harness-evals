import { mergeAgentConfig, mergeDockerConfig, mergeWorkspaceConfig } from '../config/merge.js';
import type { AgentConfig, CliOverrides, LoadedHarnessConfig, MatrixEntry, TestCase } from '../config/schema.js';

export function buildMatrix(config: LoadedHarnessConfig, cli: CliOverrides = {}): MatrixEntry[] {
  const entries: MatrixEntry[] = [];
  const selectedTests = filterTests(config.testCases, cli);

  for (const testCase of selectedTests) {
    const agentNames = selectAgents(Object.keys(config.agents), testCase, cli);
    const attempts = cli.attempts ?? testCase.attempts ?? 1;
    if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer');
    for (const agentName of agentNames) {
      const baseAgent = config.agents[agentName];
      if (!baseAgent) throw new Error(`Unknown agent selected by ${testCase.id}: ${agentName}`);

      const agent = applyMergeOrder(baseAgent, testCase, agentName, cli);
      const workspace = mergeWorkspaceConfig(config.workspace, testCase.workspace);
      const dockerOverride = {
        ...(testCase.image ? { baseImage: testCase.image } : {}),
        ...(cli.dockerImage ? { image: cli.dockerImage } : {}),
      };
      const docker = mergeDockerConfig(config.docker, Object.keys(dockerOverride).length ? dockerOverride : undefined);
      for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex++) {
        entries.push({ testCase, agentName, agent, workspace, docker, attemptIndex, attemptNumber: attemptIndex + 1, attempts });
      }
    }
  }

  return entries;
}

function filterTests(testCases: TestCase[], cli: CliOverrides): TestCase[] {
  return testCases.filter((testCase) => {
    if (cli.caseId && testCase.id !== cli.caseId) return false;
    if (cli.suite && testCase.suite !== cli.suite) return false;
    return true;
  });
}

function selectAgents(allAgentNames: string[], testCase: TestCase, cli: CliOverrides): string[] {
  const include = cli.agents ?? testCase.agents?.include ?? allAgentNames;
  const exclude = new Set(testCase.agents?.exclude ?? []);
  return include.filter((name) => !exclude.has(name));
}

function applyMergeOrder(baseAgent: AgentConfig, testCase: TestCase, agentName: string, cli: CliOverrides): AgentConfig {
  const testBase: Partial<AgentConfig> = {
    timeoutMs: testCase.timeoutMs,
    parser: testCase.parser,
  };
  const wildcard = testCase.agents?.overrides?.['*'];
  const named = testCase.agents?.overrides?.[agentName];
  const cliOverride: Partial<AgentConfig> = {
    provider: cli.provider,
    model: cli.model,
    timeoutMs: cli.timeoutMs,
  };

  return mergeAgentConfig(
    mergeAgentConfig(
      mergeAgentConfig(
        mergeAgentConfig(baseAgent, testBase),
        wildcard,
      ),
      named,
    ),
    cliOverride,
  );
}
