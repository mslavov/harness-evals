import type { AgentAdapter } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { LoadedHarnessConfig } from '../config/schema.js';
import { parseJudgeResponse } from './parse.js';
import type { JudgeRunner } from './types.js';

export interface AdapterJudgeRunnerInput {
  config: LoadedHarnessConfig;
  registry: AdapterRegistry;
}

export function createAdapterJudgeRunner(input: AdapterJudgeRunnerInput): JudgeRunner {
  return async (request) => {
    const selected = selectFirstCompletionAgent(input.config, input.registry);
    if (!selected) throw new Error('llmJudge requires judge.provider/model/apiKeyEnv or at least one configured agent whose adapter supports complete()');

    const rawOutput = await selected.adapter.complete!({
      projectRoot: input.config.projectRoot,
      agentName: selected.agentName,
      agent: selected.agent,
      input: request.prompt,
    });
    const parsed = parseJudgeResponse(rawOutput);
    return {
      ...parsed,
      metadata: {
        ...(parsed.metadata ?? {}),
        rawOutput,
        source: 'agent-adapter',
        agentName: selected.agentName,
        adapter: selected.adapter.name,
      },
    };
  };
}

function selectFirstCompletionAgent(config: LoadedHarnessConfig, registry: AdapterRegistry): { agentName: string; agent: LoadedHarnessConfig['agents'][string]; adapter: AgentAdapter } | undefined {
  for (const [agentName, agent] of Object.entries(config.agents)) {
    const adapter = registry.require(agent.adapter);
    if (adapter.complete) return { agentName, agent, adapter };
  }
  return undefined;
}
