import type { AdapterRegistry } from '../adapters/registry.js';
import type { LoadedHarnessConfig } from '../config/schema.js';
import { createAdapterJudgeRunner } from './adapter.js';
import { defaultJudgeRunner } from './default.js';
import type { JudgeRequest, JudgeRunner } from './types.js';

export interface ConfiguredJudgeRunnerInput {
  config: LoadedHarnessConfig;
  registry: AdapterRegistry;
}

export function createConfiguredJudgeRunner(input: ConfiguredJudgeRunnerInput): JudgeRunner {
  const adapterJudgeRunner = createAdapterJudgeRunner(input);
  return async (request) => explicitJudgeRequest(request) ? defaultJudgeRunner(request) : adapterJudgeRunner(request);
}

function explicitJudgeRequest(request: JudgeRequest): boolean {
  return Boolean(request.provider || request.model || request.apiKeyEnv);
}
