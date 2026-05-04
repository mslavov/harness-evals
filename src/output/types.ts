export interface OutputProviderConfig {
  type: string;
  module?: string;
  export?: string;
  config?: Record<string, unknown>;
}

export type OutputRecordType =
  | 'run.started'
  | 'image.resolution'
  | 'mock.config'
  | 'mock.call'
  | 'step.started'
  | 'step.command'
  | 'step.stdout'
  | 'step.stderr'
  | 'step.events'
  | 'step.judge'
  | 'step.assertions'
  | 'step.score'
  | 'step.cost'
  | 'step.completed'
  | 'workspace.diff'
  | 'scenario.scoreSummary'
  | 'scenario.costSummary'
  | 'run.result'
  | 'run.summary'
  | 'visualization.report';

export interface OutputRecord {
  runId: string;
  sequence: number;
  type: OutputRecordType;
  timestamp: string;
  scenarioId?: string;
  agentName?: string;
  stepId?: string;
  payload: unknown;
  redacted: boolean;
}

export interface OutputRecordInput {
  type: OutputRecordType;
  payload: unknown;
  scenarioId?: string;
  agentName?: string;
  stepId?: string;
  timestamp?: string;
}

export interface OutputBlob {
  runId: string;
  type: string;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
}

export interface OutputBlobRef {
  provider: string;
  uri: string;
  metadata?: Record<string, unknown>;
}

export type OutputRunStatus = 'passed' | 'failed' | 'error' | 'incomplete';

export interface OutputProviderFailure {
  provider: string;
  operation: 'initialize' | 'write' | 'writeBlob' | 'finalize';
  sequence?: number;
  recordType?: OutputRecordType;
  message: string;
}

export interface OutputFinalizeInput {
  runId: string;
  status: OutputRunStatus;
  providerFailures?: OutputProviderFailure[];
}

export interface OutputProviderInitializeInput {
  projectRoot: string;
  runId: string;
  scenarioId?: string;
  agentName?: string;
  config: Record<string, unknown>;
}

export interface OutputProvider {
  type: string;
  initialize(input: OutputProviderInitializeInput): Promise<void> | void;
  write(record: OutputRecord): Promise<void> | void;
  writeBlob?(blob: OutputBlob): Promise<OutputBlobRef> | OutputBlobRef;
  finalize(result: OutputFinalizeInput): Promise<void> | void;
}

export type OutputProviderFactory = () => OutputProvider;
