export interface ToolCallSummary {
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface AgentEventsSummary {
  finalOutput: string;
  toolCalls: ToolCallSummary[];
  errors: string[];
}

export interface ParseEventsInput {
  stdout: string;
  stderr: string;
}
