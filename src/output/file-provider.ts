import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VisualizationConfig } from '../config/schema.js';
import { buildRunReport } from '../visualization/report.js';
import { renderReport } from '../visualization/render.js';
import type { VisualizationFormat } from '../visualization/types.js';
import type { OutputBlob, OutputBlobRef, OutputFinalizeInput, OutputProvider, OutputRecord } from './types.js';

export interface FileOutputProviderOptions {
  projectRoot: string;
  outputRoot: string;
  runDir?: string;
  visualization?: VisualizationConfig;
}

export function createFileOutputProvider(options: FileOutputProviderOptions): OutputProvider {
  return new FileOutputProvider(options);
}

const DEFAULT_VISUALIZATION_CONFIG: VisualizationConfig = {
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
};

class FileOutputProvider implements OutputProvider {
  readonly type = 'file';

  constructor(private readonly options: FileOutputProviderOptions) {}

  async initialize(): Promise<void> {
    if (this.options.runDir) await mkdir(this.options.runDir, { recursive: true });
    if (this.visualization().enabled && this.visualization().latest && this.visualization().formats.length > 0) {
      await mkdir(join(this.options.outputRoot, 'latest'), { recursive: true });
    }
  }

  async write(record: OutputRecord): Promise<void> {
    if (this.options.runDir) {
      await appendJsonLine(join(this.options.runDir, 'records.jsonl'), record);
      await this.writeRunArtifact(record);
    }

    if (record.type === 'run.summary') {
      await this.writeLatestSummary(record.payload);
    }
  }

  async writeBlob(blob: OutputBlob): Promise<OutputBlobRef> {
    const root = this.options.runDir ?? this.options.outputRoot;
    const path = join(root, 'blobs', sanitizePathPart(blob.type), sanitizePathPart(blob.name));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, blob.bytes);
    return {
      provider: this.type,
      uri: pathToFileURL(path).href,
      metadata: {
        path,
        contentType: blob.contentType,
        ...(blob.metadata ?? {}),
      },
    };
  }

  async finalize(result: OutputFinalizeInput): Promise<void> {
    if (!this.options.runDir) return;
    await writeJson(join(this.options.runDir, 'finalize.json'), result);
  }

  private async writeRunArtifact(record: OutputRecord): Promise<void> {
    if (!this.options.runDir) return;

    switch (record.type) {
      case 'run.started':
        await writeJson(join(this.options.runDir, 'run-started.json'), record.payload);
        break;
      case 'image.resolution':
        await writeJson(join(this.options.runDir, 'image-resolution.json'), record.payload);
        break;
      case 'mock.config':
        await writeJson(join(this.options.runDir, 'mock-config.json'), record.payload);
        if (record.stepId) await writeJson(join(this.options.runDir, 'steps', sanitizePathPart(record.stepId), 'mock-config.json'), record.payload);
        break;
      case 'mock.call':
        await appendJsonLine(join(this.options.runDir, 'mock-calls.jsonl'), record.payload);
        if (record.stepId) await appendJsonLine(join(this.options.runDir, 'steps', sanitizePathPart(record.stepId), 'mock-calls.jsonl'), record.payload);
        break;
      case 'verifier.started':
        await writeJson(join(this.options.runDir, 'verifier', 'verifier-started.json'), record.payload);
        break;
      case 'verifier.command':
        await writeJson(join(this.options.runDir, 'verifier', 'command.redacted.json'), record.payload);
        break;
      case 'verifier.stdout':
        await writeText(join(this.options.runDir, 'verifier', 'stdout.log'), payloadText(record.payload));
        break;
      case 'verifier.stderr':
        await writeText(join(this.options.runDir, 'verifier', 'stderr.log'), payloadText(record.payload));
        break;
      case 'verifier.reward':
        await writeJson(join(this.options.runDir, 'verifier', 'reward.json'), record.payload);
        break;
      case 'verifier.completed':
        await writeJson(join(this.options.runDir, 'verifier', 'result.json'), record.payload);
        break;
      case 'workspace.modelPatch':
        await writeText(join(this.options.runDir, 'model.patch'), readPayloadContent(record.payload));
        break;
      case 'workspace.hiddenPatch':
        await writeJson(join(this.options.runDir, 'hidden-patch.json'), record.payload);
        break;
      case 'workspace.diff':
        await writeJson(join(this.options.runDir, 'workspace-diff.json'), record.payload);
        break;
      case 'scenario.scoreSummary':
        await writeJson(join(this.options.runDir, 'score-summary.json'), record.payload);
        break;
      case 'scenario.costSummary':
        await writeJson(join(this.options.runDir, 'cost-summary.json'), record.payload);
        break;
      case 'run.result':
        await writeJson(join(this.options.runDir, 'result.json'), record.payload);
        await this.writeRunIndex(record.payload);
        break;
      case 'run.summary':
        await writeJson(join(this.options.runDir, 'summary.json'), record.payload);
        break;
      case 'visualization.report':
        await this.writeVisualizationReport(record.payload);
        break;
      default:
        await this.writeStepArtifact(record);
        break;
    }
  }

  private async writeStepArtifact(record: OutputRecord): Promise<void> {
    if (!this.options.runDir || !record.type.startsWith('step.')) return;
    const stepDir = join(this.options.runDir, 'steps', sanitizePathPart(record.stepId ?? 'step'));

    switch (record.type) {
      case 'step.started':
        await writeJson(join(stepDir, 'step-started.json'), record.payload);
        break;
      case 'step.command':
        await writeJson(join(stepDir, 'command.redacted.json'), record.payload);
        break;
      case 'step.stdout':
        // Streamed payloads reference an artifact the runner already wrote.
        if (!isStreamedArtifactPayload(record.payload)) await writeText(join(stepDir, 'stdout.log'), payloadText(record.payload));
        break;
      case 'step.stderr':
        if (!isStreamedArtifactPayload(record.payload)) await writeText(join(stepDir, 'stderr.log'), payloadText(record.payload));
        break;
      case 'step.events':
        await writeJson(join(stepDir, 'events-summary.json'), record.payload);
        break;
      case 'step.judge':
        await writeJson(join(stepDir, 'judges', `${sanitizePathPart(readPayloadId(record.payload) ?? `judge-${record.sequence}`)}.json`), record.payload);
        break;
      case 'step.assertions':
        await writeJson(join(stepDir, 'assertions.json'), record.payload);
        break;
      case 'step.score':
        await writeJson(join(stepDir, 'score.json'), record.payload);
        break;
      case 'step.cost':
        await writeJson(join(stepDir, 'cost.json'), record.payload);
        break;
      case 'step.completed':
        await writeJson(join(stepDir, 'step-completed.json'), record.payload);
        break;
    }
  }

  private async writeVisualizationReport(payload: unknown): Promise<void> {
    if (!this.options.runDir) return;
    const record = isRecord(payload) ? payload : {};
    if (typeof record.content !== 'string') return;
    const format = typeof record.format === 'string' ? record.format : 'json';
    const name = typeof record.name === 'string' ? record.name : `visualization-report.${format}`;
    await writeText(join(this.options.runDir, sanitizePathPart(name)), record.content);
  }

  private async writeLatestSummary(payload: unknown): Promise<void> {
    const visualization = this.visualization();
    if (!visualization.enabled || !visualization.latest || !isHarnessSummaryPayload(payload)) return;

    const latestDir = join(this.options.outputRoot, 'latest');
    const report = buildRunReport(payload, { runId: 'latest', include: visualization.include });
    await mkdir(latestDir, { recursive: true });
    for (const format of visualization.formats) {
      await writeText(join(latestDir, `results.${format}`), renderReport(report, format));
    }
  }

  private async writeRunIndex(payload: unknown): Promise<void> {
    if (!this.options.runDir || !this.shouldRenderFormat('html')) return;
    const report = buildRunReport(payload, { include: this.visualization().include });
    await writeText(join(this.options.runDir, 'index.html'), renderReport(report, 'html'));
  }

  private shouldRenderFormat(format: VisualizationFormat): boolean {
    const visualization = this.visualization();
    return visualization.enabled && visualization.formats.includes(format);
  }

  private visualization(): VisualizationConfig {
    return this.options.visualization ?? DEFAULT_VISUALIZATION_CONFIG;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (isRecord(payload) && typeof payload.text === 'string') return payload.text;
  return JSON.stringify(payload, null, 2);
}

function readPayloadId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.assertionId === 'string') return payload.assertionId;
  if (typeof payload.id === 'string') return payload.id;
  return undefined;
}

function readPayloadContent(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (isRecord(payload) && typeof payload.content === 'string') return payload.content;
  return '';
}

function isHarnessSummaryPayload(payload: unknown): payload is { pass: boolean; results: Array<Record<string, unknown>> } {
  return isRecord(payload) && typeof payload.pass === 'boolean' && Array.isArray(payload.results);
}

function sanitizePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
}

function isStreamedArtifactPayload(payload: unknown): boolean {
  return isRecord(payload) && payload.streamed === true && typeof payload.file === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
