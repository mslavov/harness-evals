import { redactJson, type Redaction } from '../redaction.js';
import type {
  OutputBlob,
  OutputBlobRef,
  OutputFinalizeInput,
  OutputProvider,
  OutputProviderFailure,
  OutputProviderInitializeInput,
  OutputRecord,
  OutputRecordInput,
  OutputRunStatus,
} from './types.js';

export interface ConfiguredOutputProvider {
  provider: OutputProvider;
  config?: Record<string, unknown>;
}

export interface CreateOutputDispatcherInput {
  projectRoot: string;
  runId: string;
  scenarioId?: string;
  agentName?: string;
  redactions: readonly Redaction[];
  providers: ConfiguredOutputProvider[];
}

export class OutputDispatcher {
  private sequence = 0;
  private readonly activeProviders: ConfiguredOutputProvider[] = [];
  private readonly failures: OutputProviderFailure[] = [];
  private finalized = false;

  constructor(private readonly input: CreateOutputDispatcherInput) {
    if (input.providers.length === 0) throw new Error('At least one output provider is required');
  }

  get providerFailures(): OutputProviderFailure[] {
    return this.failures.map((failure) => ({ ...failure }));
  }

  async initialize(): Promise<void> {
    const hasFileProvider = this.input.providers.some((entry) => isFileProvider(entry.provider));
    const requiredProviders = hasFileProvider ? this.input.providers.filter((entry) => isFileProvider(entry.provider)) : this.input.providers;
    const optionalProviders = hasFileProvider ? this.input.providers.filter((entry) => !isFileProvider(entry.provider)) : [];

    for (const entry of requiredProviders) {
      await initializeProvider(entry, this.initializeInput(entry));
      this.activeProviders.push(entry);
    }

    for (const entry of optionalProviders) {
      try {
        await initializeProvider(entry, this.initializeInput(entry));
        this.activeProviders.push(entry);
      } catch (error) {
        this.failures.push(providerFailure(entry.provider, 'initialize', error));
      }
    }
  }

  async emit(input: OutputRecordInput): Promise<OutputRecord> {
    if (this.finalized) throw new Error('Output dispatcher is finalized');

    const record = redactJson({
      runId: this.input.runId,
      sequence: ++this.sequence,
      type: input.type,
      timestamp: input.timestamp ?? new Date().toISOString(),
      scenarioId: input.scenarioId ?? this.input.scenarioId,
      agentName: input.agentName ?? this.input.agentName,
      stepId: input.stepId,
      payload: input.payload,
      redacted: true,
    }, this.input.redactions) as OutputRecord;

    await this.writeToProviders(record);
    return record;
  }

  async writeBlob(blob: OutputBlob): Promise<OutputBlobRef[]> {
    const active = this.activeProviders.filter((entry) => entry.provider.writeBlob);
    if (active.length === 0) return [];

    const hasFileProvider = this.activeProviders.some((entry) => isFileProvider(entry.provider));
    const requiredProviders = hasFileProvider ? active.filter((entry) => isFileProvider(entry.provider)) : active;
    const optionalProviders = hasFileProvider ? active.filter((entry) => !isFileProvider(entry.provider)) : [];
    const refs: OutputBlobRef[] = [];

    for (const entry of requiredProviders) {
      refs.push(await writeProviderBlob(entry, blob));
    }

    for (const entry of optionalProviders) {
      try {
        refs.push(await writeProviderBlob(entry, blob));
      } catch (error) {
        this.failures.push(providerFailure(entry.provider, 'writeBlob', error));
      }
    }

    return refs;
  }

  async finalize(input: Omit<OutputFinalizeInput, 'runId' | 'providerFailures'> & { status: OutputRunStatus }): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    const finalizeInput: OutputFinalizeInput = {
      runId: this.input.runId,
      status: input.status,
      providerFailures: this.providerFailures,
    };

    const hasFileProvider = this.activeProviders.some((entry) => isFileProvider(entry.provider));
    const requiredProviders = hasFileProvider ? this.activeProviders.filter((entry) => isFileProvider(entry.provider)) : this.activeProviders;
    const optionalProviders = hasFileProvider ? this.activeProviders.filter((entry) => !isFileProvider(entry.provider)) : [];

    for (const entry of requiredProviders) {
      await finalizeProvider(entry, finalizeInput);
    }

    for (const entry of optionalProviders) {
      try {
        await finalizeProvider(entry, finalizeInput);
      } catch (error) {
        this.failures.push(providerFailure(entry.provider, 'finalize', error));
      }
    }
  }

  private initializeInput(entry: ConfiguredOutputProvider): OutputProviderInitializeInput {
    return {
      projectRoot: this.input.projectRoot,
      runId: this.input.runId,
      scenarioId: this.input.scenarioId,
      agentName: this.input.agentName,
      config: entry.config ?? {},
    };
  }

  private async writeToProviders(record: OutputRecord): Promise<void> {
    const hasFileProvider = this.activeProviders.some((entry) => isFileProvider(entry.provider));
    const requiredProviders = hasFileProvider ? this.activeProviders.filter((entry) => isFileProvider(entry.provider)) : this.activeProviders;
    const optionalProviders = hasFileProvider ? this.activeProviders.filter((entry) => !isFileProvider(entry.provider)) : [];

    for (const entry of requiredProviders) {
      await writeProviderRecord(entry, record);
    }

    for (const entry of optionalProviders) {
      try {
        await writeProviderRecord(entry, record);
      } catch (error) {
        this.failures.push(providerFailure(entry.provider, 'write', error, record));
      }
    }
  }
}

export async function createOutputDispatcher(input: CreateOutputDispatcherInput): Promise<OutputDispatcher> {
  const dispatcher = new OutputDispatcher(input);
  await dispatcher.initialize();
  return dispatcher;
}

async function initializeProvider(entry: ConfiguredOutputProvider, input: OutputProviderInitializeInput): Promise<void> {
  try {
    await entry.provider.initialize(input);
  } catch (error) {
    throw outputProviderError(entry.provider, 'initialize', error);
  }
}

async function writeProviderRecord(entry: ConfiguredOutputProvider, record: OutputRecord): Promise<void> {
  try {
    await entry.provider.write(record);
  } catch (error) {
    throw outputProviderError(entry.provider, `write ${record.type} #${record.sequence}`, error);
  }
}

async function writeProviderBlob(entry: ConfiguredOutputProvider, blob: OutputBlob): Promise<OutputBlobRef> {
  if (!entry.provider.writeBlob) throw new Error(`Output provider ${entry.provider.type} does not implement writeBlob`);
  try {
    return await entry.provider.writeBlob(blob);
  } catch (error) {
    throw outputProviderError(entry.provider, `writeBlob ${blob.type}/${blob.name}`, error);
  }
}

async function finalizeProvider(entry: ConfiguredOutputProvider, input: OutputFinalizeInput): Promise<void> {
  try {
    await entry.provider.finalize(input);
  } catch (error) {
    throw outputProviderError(entry.provider, `finalize ${input.status}`, error);
  }
}

function outputProviderError(provider: OutputProvider, operation: string, error: unknown): Error {
  return new Error(`Output provider ${provider.type} failed to ${operation}: ${errorMessage(error)}`);
}

function providerFailure(
  provider: OutputProvider,
  operation: OutputProviderFailure['operation'],
  error: unknown,
  record?: OutputRecord,
): OutputProviderFailure {
  return {
    provider: provider.type,
    operation,
    sequence: record?.sequence,
    recordType: record?.type,
    message: errorMessage(error),
  };
}

function isFileProvider(provider: OutputProvider): boolean {
  return provider.type === 'file';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
