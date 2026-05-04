export interface UsageReport {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  requests?: number;
  totalCost?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface CostRollup {
  currency?: string;
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  requests?: number;
  metadata?: Record<string, unknown>;
}

export interface CostReport {
  available?: boolean;
  currency?: string;
  totalCost?: number;
  totalTokens?: number;
  usage?: UsageReport[];
  byProvider?: Record<string, CostRollup>;
  byModel?: Record<string, CostRollup>;
  metadata?: Record<string, unknown>;
}

export interface CostSummary {
  available: boolean;
  currency?: string;
  totalCost?: number;
  rollup: CostRollup;
  byProvider: Record<string, CostRollup>;
  byModel: Record<string, CostRollup>;
  byAgent: Record<string, CostRollup>;
  byScenario: Record<string, CostRollup>;
  byTestCase: Record<string, CostRollup>;
  byRun: Record<string, CostRollup>;
  steps: Record<string, CostReport>;
  metadata?: Record<string, unknown>;
}
