import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { expandTrustedPath, resolveProjectPath, resolveTrustedPath } from '../config/paths.js';
import type { AgentEventsSummary, ToolCallSummary } from '../events/types.js';
import { type AgentAdapter, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

interface PiSelection {
  provider?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

interface SettingsMetadata {
  globalSettingsPath?: string;
  projectSettingsPath?: string;
  templates: string[];
  sources: string[];
  currentConfig?: {
    globalSettingsSourcePath?: string;
    projectSettingsSourcePath?: string;
    warnings: string[];
  };
  generatedGlobalSettings?: unknown;
  generatedProjectSettings?: unknown;
}

const RESOURCE_FIELDS = new Set(['extensions', 'skills', 'prompts', 'themes']);
const NON_LOCAL_PREFIXES = ['npm:', 'git:', 'github:', 'http:', 'https:', 'ssh:'];
const SECRET_CONFIG_FILES = ['auth.json', 'models.json', 'model-tiers.json'];
export const PI_AUTH_ENV_NAMES = ['PI_EVAL_API_KEY'] as const;

export const piAdapter: AgentAdapter = {
  name: 'pi',
  authEnvNames: PI_AUTH_ENV_NAMES,
  getInstallRecipe(input) {
    return Promise.resolve({
      commands: ['npm install -g @earendil-works/pi-coding-agent'],
      probes: [{ command: [input.agent.command ?? 'pi', '--version'] }],
      cacheKey: '@earendil-works/pi-coding-agent',
    });
  },
  async prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan> {
    await mkdir(input.configDir, { recursive: true });

    const config = input.agent.config ?? {};
    const useCurrentConfig = readBoolean(config.useCurrentConfig) ?? input.agent.useCurrentConfig ?? true;
    const copyCurrentConfigFilesForRun = readBoolean(config.copyCurrentConfigFiles) ?? input.agent.useCurrentConfig ?? true;
    const selection = await resolvePiSelection(input.agent);
    const settings = await writeSettings(input, config, useCurrentConfig);
    const copiedConfigFiles = copyCurrentConfigFilesForRun ? await copyCurrentConfigFiles(input) : [];

    const argv = buildPiArgs({
      command: input.agent.command ?? 'pi',
      containerRepoRoot: input.docker.repoPath,
      extraArgs: input.agent.args ?? [],
      prompt: input.prompt,
      selection,
    });

    return {
      argv,
      cwd: input.agent.cwd ?? input.workspace.containerPath,
      envNames: unique([input.agent.apiKeyEnv, selection.apiKeyEnv, ...(input.agent.env ?? []), ...(input.agent.envAllowlist ?? [])]),
      envValues: { PI_CODING_AGENT_DIR: input.docker.configRoot },
      configMounts: [],
      parser: input.agent.parser ?? 'pi-jsonl',
      timeoutMs: input.agent.timeoutMs,
      cleanupPaths: copiedConfigFiles.map((file) => file.targetPath),
      metadata: {
        settings,
        configFiles: copiedConfigFiles.map((file) => ({
          source: file.source,
          target: join(input.docker.configRoot, file.targetName),
          copiedForRun: true,
          removedAfterRun: true,
        })),
        pi: {
          provider: selection.provider,
          model: selection.model,
          label: input.agent.label,
        },
      },
    };
  },
  async parseEvents(input) {
    return parsePiEvents(input.stdout);
  },
};

interface MutableToolCall extends ToolCallSummary {
  id?: string;
}

function parsePiEvents(stdout: string): AgentEventsSummary {
  const errors: string[] = [];
  const toolCalls: MutableToolCall[] = [];
  const toolCallsById = new Map<string, MutableToolCall>();
  let finalOutput = '';

  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      event = parsed;
    } catch (error) {
      errors.push(`Line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const type = event.type;
    if (type === 'tool_execution_start') {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
      const name = typeof event.toolName === 'string' ? event.toolName : 'unknown';
      const call: MutableToolCall = { id, name, args: event.args };
      toolCalls.push(call);
      if (id) toolCallsById.set(id, call);
      continue;
    }

    if (type === 'tool_execution_end') {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
      const name = typeof event.toolName === 'string' ? event.toolName : 'unknown';
      const call = (id ? toolCallsById.get(id) : undefined) ?? createToolCall(toolCalls, toolCallsById, id, name);
      call.result = event.result;
      call.isError = Boolean(event.isError);
      if (call.isError) errors.push(`Tool ${name} failed`);
      continue;
    }

    if (type === 'message_end' || type === 'turn_end') {
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role === 'assistant') {
        finalOutput = extractMessageText(message);
        collectMessageError(message, errors);
      }
      continue;
    }

    if (type === 'agent_end' && Array.isArray(event.messages)) {
      const assistant = [...event.messages]
        .reverse()
        .find((message): message is Record<string, unknown> => isRecord(message) && message.role === 'assistant');
      if (assistant) {
        finalOutput = extractMessageText(assistant);
        collectMessageError(assistant, errors);
      }
    }
  }

  if (!finalOutput) {
    const genericJson = parseJsonl(stdout);
    const final = [...genericJson].reverse().find((event) => typeof event.output === 'string' || typeof event.text === 'string');
    finalOutput = typeof final?.output === 'string' ? final.output : typeof final?.text === 'string' ? final.text : '';
  }

  return {
    finalOutput,
    toolCalls: toolCalls.map(({ id: _id, ...call }) => call),
    errors,
  };
}

function parseJsonl(input: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
    }
  }

  return events;
}

function createToolCall(
  toolCalls: MutableToolCall[],
  toolCallsById: Map<string, MutableToolCall>,
  id: string | undefined,
  name: string,
): MutableToolCall {
  const call: MutableToolCall = { id, name };
  toolCalls.push(call);
  if (id) toolCallsById.set(id, call);
  return call;
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function collectMessageError(message: Record<string, unknown>, errors: string[]): void {
  const stopReason = message.stopReason;
  if ((stopReason === 'error' || stopReason === 'aborted') && typeof message.errorMessage === 'string') {
    errors.push(message.errorMessage);
  }
}

function buildPiArgs(options: {
  command: string;
  containerRepoRoot: string;
  extraArgs: string[];
  prompt: string;
  selection: PiSelection;
}): string[] {
  const args = [options.command, '--mode', 'json', '--no-session', '--no-context-files'];

  if (options.selection.provider) args.push('--provider', options.selection.provider);
  if (options.selection.model) args.push('--model', options.selection.model);
  if (options.selection.apiKey) args.push('--api-key', options.selection.apiKey);

  args.push(...options.extraArgs, options.prompt);
  return args;
}

async function resolvePiSelection(agent: AgentStepPrepareInput['agent']): Promise<PiSelection> {
  const configuredApiKeyEnv = readString(agent.apiKeyEnv);
  const implicitApiKeyEnv = readString(process.env.PI_EVAL_API_KEY) ? 'PI_EVAL_API_KEY' : undefined;
  const apiKeyEnv = configuredApiKeyEnv ?? implicitApiKeyEnv;
  const currentDefaults = await readCurrentModelDefaults(agent);
  return {
    provider: readString(agent.provider) ?? readString(agent.providerEnv ? process.env[agent.providerEnv] : undefined) ?? readString(process.env.PI_EVAL_PROVIDER) ?? currentDefaults.provider,
    model: readString(agent.model) ?? readString(agent.modelEnv ? process.env[agent.modelEnv] : undefined) ?? readString(process.env.PI_EVAL_MODEL) ?? currentDefaults.model,
    apiKey: apiKeyEnv ? readString(process.env[apiKeyEnv]) : undefined,
    apiKeyEnv,
  };
}

async function readCurrentModelDefaults(agent: AgentStepPrepareInput['agent']): Promise<{ provider?: string; model?: string }> {
  const settingsPath = join(getCurrentAgentDir(agent), 'settings.json');
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(raw) as unknown;
    if (!isRecord(settings)) return {};
    return {
      provider: readString(settings.defaultProvider),
      model: readString(settings.defaultModel),
    };
  } catch {
    return {};
  }
}

async function writeSettings(
  input: AgentStepPrepareInput,
  config: Record<string, unknown>,
  useCurrentConfig: boolean,
): Promise<SettingsMetadata> {
  const templates: string[] = [];
  const sources: string[] = [];
  const currentWarnings: string[] = [];
  const metadata: SettingsMetadata = { templates, sources };
  const globalTemplate = readNullableString(config.globalSettingsTemplate);
  const projectTemplate = readNullableString(config.projectSettingsTemplate);

  if (globalTemplate) {
    templates.push(globalTemplate);
    sources.push(`template:${globalTemplate}`);
    const settings = await loadAndRenderTemplate(input.projectRoot, globalTemplate, input.docker.repoPath);
    await writeJson(join(input.configDir, 'settings.json'), settings);
    metadata.globalSettingsPath = join(input.docker.configRoot, 'settings.json');
    metadata.generatedGlobalSettings = settings;
  } else if (useCurrentConfig && globalTemplate !== null) {
    const sourcePath = join(getCurrentAgentDir(input.agent), 'settings.json');
    const settings = await loadAndRenderCurrentSettings(sourcePath, dirname(sourcePath), input, currentWarnings);
    if (settings !== undefined) {
      sources.push(`current:${sourcePath}`);
      await writeJson(join(input.configDir, 'settings.json'), settings);
      metadata.globalSettingsPath = join(input.docker.configRoot, 'settings.json');
      metadata.currentConfig = metadata.currentConfig ?? { warnings: currentWarnings };
      metadata.currentConfig.globalSettingsSourcePath = sourcePath;
    }
  }

  if (projectTemplate) {
    templates.push(projectTemplate);
    sources.push(`template:${projectTemplate}`);
    const settings = await loadAndRenderTemplate(input.projectRoot, projectTemplate, input.docker.repoPath);
    await writeJson(join(input.workspaceDir, '.pi', 'settings.json'), settings);
    metadata.projectSettingsPath = join(input.workspace.containerPath, '.pi', 'settings.json');
    metadata.generatedProjectSettings = settings;
  } else if (useCurrentConfig && projectTemplate !== null) {
    const sourcePath = getCurrentProjectSettingsPath(input);
    const settings = await loadAndRenderCurrentSettings(sourcePath, dirname(sourcePath), input, currentWarnings);
    if (settings !== undefined) {
      sources.push(`current:${sourcePath}`);
      await writeJson(join(input.workspaceDir, '.pi', 'settings.json'), settings);
      metadata.projectSettingsPath = join(input.workspace.containerPath, '.pi', 'settings.json');
      metadata.currentConfig = metadata.currentConfig ?? { warnings: currentWarnings };
      metadata.currentConfig.projectSettingsSourcePath = sourcePath;
    }
  }

  if (currentWarnings.length > 0) metadata.currentConfig = metadata.currentConfig ?? { warnings: currentWarnings };
  return metadata;
}

async function loadAndRenderTemplate(projectRoot: string, template: string, containerRepoRoot: string): Promise<unknown> {
  const templatePath = resolveProjectPath(projectRoot, template, 'pi config template');
  const raw = await readFile(templatePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`Settings template must be a JSON object: ${template}`);
  return renderTemplateValue(parsed, containerRepoRoot);
}

async function loadAndRenderCurrentSettings(
  path: string,
  baseDir: string,
  input: AgentStepPrepareInput,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  if (!(await pathExists(path))) return undefined;

  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`Current settings file must be a JSON object: ${path}`);
  return renderCurrentSettings(parsed, baseDir, input, warnings);
}

function renderCurrentSettings(
  settings: Record<string, unknown>,
  baseDir: string,
  input: AgentStepPrepareInput,
  warnings: string[],
): Record<string, unknown> {
  const rendered: Record<string, unknown> = { ...settings };

  if (Array.isArray(rendered.packages)) {
    rendered.packages = rendered.packages.map((pkg) => renderPackageEntry(pkg, baseDir, input, warnings));
  }

  for (const field of RESOURCE_FIELDS) {
    const value = rendered[field];
    if (Array.isArray(value)) {
      rendered[field] = value.map((entry) => {
        if (typeof entry !== 'string') return entry;
        return renderLocalSource(entry, baseDir, input, warnings);
      });
    }
  }

  return rendered;
}

function renderPackageEntry(pkg: unknown, baseDir: string, input: AgentStepPrepareInput, warnings: string[]): unknown {
  if (typeof pkg === 'string') return renderLocalSource(pkg, baseDir, input, warnings);
  if (!isRecord(pkg) || typeof pkg.source !== 'string') return pkg;
  return { ...pkg, source: renderLocalSource(pkg.source, baseDir, input, warnings) };
}

function renderLocalSource(source: string, baseDir: string, input: AgentStepPrepareInput, warnings: string[]): string {
  const renderedTemplate = renderTemplateString(source, input.docker.repoPath);
  if (!isLocalSource(renderedTemplate)) return renderedTemplate;

  const hostPath = isAbsolute(renderedTemplate) ? resolve(renderedTemplate) : resolve(baseDir, renderedTemplate);
  const repoRelative = relative(input.projectRoot, hostPath).split('\\').join('/');
  if (!repoRelative.startsWith('..') && repoRelative !== '..' && !isAbsolute(repoRelative)) {
    return `${input.docker.repoPath}/${repoRelative}`;
  }

  warnings.push(`Leaving local path unchanged because it is outside the Docker repo context: ${source}`);
  return source;
}

function renderTemplateValue(value: unknown, containerRepoRoot: string): unknown {
  if (typeof value === 'string') return renderTemplateString(value, containerRepoRoot);
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, containerRepoRoot));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, renderTemplateValue(child, containerRepoRoot)]));
  }
  return value;
}

function renderTemplateString(value: string, containerRepoRoot: string): string {
  return value.replace(/\$\{repoPackage:([^}]+)}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid repoPackage name: ${rawName}`);
    return `${containerRepoRoot}/packages/${name}`;
  });
}

async function copyCurrentConfigFiles(input: AgentStepPrepareInput): Promise<Array<{ source: string; targetName: string; targetPath: string }>> {
  const agentDir = getCurrentAgentDir(input.agent);
  const copied: Array<{ source: string; targetName: string; targetPath: string }> = [];

  for (const targetName of SECRET_CONFIG_FILES) {
    const source = join(agentDir, targetName);
    if (!(await pathExists(source))) continue;

    const targetPath = join(input.configDir, targetName);
    await copyFile(source, targetPath);
    await chmod(targetPath, 0o600);
    copied.push({ source, targetName, targetPath });
  }

  return copied;
}

export async function removePiSecretCopies(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

function getCurrentProjectSettingsPath(input: AgentStepPrepareInput): string {
  const projectConfigDir = input.agent.projectConfigDirs?.[0];
  if (projectConfigDir) return join(resolveTrustedPath(input.projectRoot, projectConfigDir), 'settings.json');
  return join(input.projectRoot, '.pi', 'settings.json');
}

function getCurrentAgentDir(agent: AgentStepPrepareInput['agent']): string {
  const configured = agent.userConfigDirs?.[0];
  if (configured) return expandTrustedPath(configured);
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isLocalSource(source: string): boolean {
  const trimmed = source.trim();
  return !NON_LOCAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readString(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
