import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { AdapterInstallRecipe, AdapterProbe, ResolvedAgentConfig } from '../adapters/types.js';
import type { DockerConfig } from '../config/schema.js';

export type ImageMode = 'ready' | 'managed';

export interface ImageResolutionAgent {
  agentName: string;
  agent: ResolvedAgentConfig;
}

export interface ImageResolutionInput {
  projectRoot: string;
  docker: DockerConfig;
  selectedAgents: ImageResolutionAgent[];
  adapterRegistry: AdapterRegistry;
  refreshManagedImage?: boolean;
}

export interface InstallManifest {
  schemaVersion: 1;
  baseImage: string;
  recipes: NormalizedInstallRecipe[];
}

export interface NormalizedInstallRecipe {
  adapter: string;
  adapterVersion?: string;
  agentName: string;
  commands: string[];
  probes: NormalizedAdapterProbe[];
  cacheKey?: string;
}

export interface NormalizedAdapterProbe {
  command: string[];
  expectedExitCode: number;
}

export interface ProbeResult {
  command: string[];
  expectedExitCode: number;
  exitCode: number | null;
  pass: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  errorMessage?: string;
}

export interface ImageResolutionResult {
  mode: ImageMode;
  image: string;
  manifest?: InstallManifest;
  cacheKey?: string;
  cacheHit?: boolean;
  probes: ProbeResult[];
}

interface DockerCommandResult {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  errorMessage?: string;
}

const IMAGE_SCHEMA_VERSION = 1;
const MANAGED_BASE_IMAGE = 'node:22-bookworm-slim';
const MANAGED_TAG_PREFIX = 'harness-evals-managed';
const IMAGE_CACHE_DIR = '.harness-evals/image-cache';

interface ManagedResolutionInFlight {
  promise: Promise<ImageResolutionResult>;
  refreshManagedImage: boolean;
}

const inFlightManagedResolutions = new Map<string, ManagedResolutionInFlight>();

export class ImageResolutionError extends Error {
  constructor(message: string, readonly resolution?: ImageResolutionResult) {
    super(message);
    this.name = 'ImageResolutionError';
  }
}

export async function resolveDockerImage(input: ImageResolutionInput): Promise<ImageResolutionResult> {
  const recipes = await collectInstallRecipes(input);
  if (input.docker.image) return resolveReadyImage(input.docker.image, recipes, input.docker.timeoutMs);

  const manifest = buildInstallManifest(recipes);
  const cacheKey = computeCacheKey(manifest);
  const image = `${MANAGED_TAG_PREFIX}:${cacheKey}`;
  const refreshManagedImage = input.refreshManagedImage ?? false;
  const existing = inFlightManagedResolutions.get(cacheKey);
  if (existing) {
    if (!refreshManagedImage || existing.refreshManagedImage) return existing.promise;

    const resolution = (async () => {
      try {
        await existing.promise;
      } catch {
        // The refresh below performs its own build and probe.
      }
      return resolveManagedImage({ projectRoot: input.projectRoot, docker: input.docker, image, manifest, cacheKey, refreshManagedImage: true });
    })();
    inFlightManagedResolutions.set(cacheKey, { promise: resolution, refreshManagedImage: true });
    try {
      return await resolution;
    } finally {
      if (inFlightManagedResolutions.get(cacheKey)?.promise === resolution) inFlightManagedResolutions.delete(cacheKey);
    }
  }

  const resolution = resolveManagedImage({ projectRoot: input.projectRoot, docker: input.docker, image, manifest, cacheKey, refreshManagedImage });
  inFlightManagedResolutions.set(cacheKey, { promise: resolution, refreshManagedImage });
  try {
    return await resolution;
  } finally {
    if (inFlightManagedResolutions.get(cacheKey)?.promise === resolution) inFlightManagedResolutions.delete(cacheKey);
  }
}

async function resolveReadyImage(image: string, recipes: NormalizedInstallRecipe[], timeoutMs: number): Promise<ImageResolutionResult> {
  const probes = await runProbes(image, collectProbes(recipes), timeoutMs);
  const result: ImageResolutionResult = { mode: 'ready', image, probes };
  const failure = probes.find((probe) => !probe.pass);
  if (failure) {
    throw new ImageResolutionError(
      `Ready Docker image ${image} failed probe ${formatCommand(failure.command)} (exit ${formatExitCode(failure.exitCode)}, expected ${failure.expectedExitCode}). Supply a ready image with the required tools or remove docker.image to use a managed image.`,
      result,
    );
  }
  return result;
}

async function resolveManagedImage(input: {
  projectRoot: string;
  docker: DockerConfig;
  image: string;
  manifest: InstallManifest;
  cacheKey: string;
  refreshManagedImage?: boolean;
}): Promise<ImageResolutionResult> {
  const refreshManagedImage = input.refreshManagedImage ?? false;
  let cacheHit = false;
  if (!refreshManagedImage) {
    cacheHit = await imageExists(input.image, input.docker.timeoutMs);
    if (cacheHit) {
      const probes = await runProbes(input.image, collectProbes(input.manifest.recipes), input.docker.timeoutMs);
      if (probes.every((probe) => probe.pass)) {
        return {
          mode: 'managed',
          image: input.image,
          manifest: input.manifest,
          cacheKey: input.cacheKey,
          cacheHit: true,
          probes,
        };
      }
    }
  }

  await buildManagedImage(input.projectRoot, input.image, input.manifest, input.cacheKey, input.docker.timeoutMs, cacheHit, refreshManagedImage);
  const probes = await runProbes(input.image, collectProbes(input.manifest.recipes), input.docker.timeoutMs);
  const result: ImageResolutionResult = {
    mode: 'managed',
    image: input.image,
    manifest: input.manifest,
    cacheKey: input.cacheKey,
    cacheHit: false,
    probes,
  };
  const failure = probes.find((probe) => !probe.pass);
  if (failure) {
    throw new ImageResolutionError(
      `Managed Docker image ${input.image} failed probe ${formatCommand(failure.command)} (exit ${formatExitCode(failure.exitCode)}, expected ${failure.expectedExitCode}) after ${refreshManagedImage ? 'refresh' : cacheHit ? 'cache rebuild' : 'build'}. Fix the adapter install recipe or supply docker.image with a ready image.`,
      result,
    );
  }
  return result;
}

async function buildManagedImage(
  projectRoot: string,
  image: string,
  manifest: InstallManifest,
  cacheKey: string,
  timeoutMs: number,
  rebuildingCacheHit: boolean,
  refreshManagedImage: boolean,
): Promise<void> {
  const contextDir = join(projectRoot, IMAGE_CACHE_DIR, cacheKey);
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(contextDir, 'Dockerfile'), renderDockerfile(manifest, cacheKey));

  const args = refreshManagedImage
    ? ['build', '--pull', '--no-cache', '-t', image, contextDir]
    : ['build', '-t', image, contextDir];
  const result = await runDockerCommand(args, timeoutMs);
  if (result.exitCode !== 0 || result.errorMessage) {
    throw new ImageResolutionError(
      `Managed Docker image build failed for ${image}${refreshManagedImage ? ' while refreshing' : rebuildingCacheHit ? ' while rebuilding a failed cache hit' : ''}: ${result.errorMessage ?? firstOutputLine(result.stderr, result.stdout)}`,
      { mode: 'managed', image, manifest, cacheKey, cacheHit: false, probes: [] },
    );
  }
}

async function collectInstallRecipes(input: ImageResolutionInput): Promise<NormalizedInstallRecipe[]> {
  const recipes: NormalizedInstallRecipe[] = [];
  const seen = new Set<string>();

  for (const selected of [...input.selectedAgents].sort(compareSelectedAgents)) {
    const adapter = input.adapterRegistry.require(selected.agent.adapter);
    const recipe = adapter.getInstallRecipe
      ? await adapter.getInstallRecipe({
        projectRoot: input.projectRoot,
        agentName: selected.agentName,
        agent: selected.agent,
        docker: input.docker,
      })
      : undefined;
    if (!recipe) continue;

    const normalized = normalizeInstallRecipe({
      adapter: adapter.name,
      adapterVersion: adapter.version,
      agentName: selected.agentName,
      recipe,
    });
    const key = stableStringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    recipes.push(normalized);
  }

  return recipes.sort(compareRecipes);
}

function buildInstallManifest(recipes: NormalizedInstallRecipe[]): InstallManifest {
  return {
    schemaVersion: IMAGE_SCHEMA_VERSION,
    baseImage: MANAGED_BASE_IMAGE,
    recipes,
  };
}

function normalizeInstallRecipe(input: {
  adapter: string;
  adapterVersion?: string;
  agentName: string;
  recipe: AdapterInstallRecipe;
}): NormalizedInstallRecipe {
  if (!Array.isArray(input.recipe.commands)) throw new Error(`Adapter ${input.adapter} install recipe commands must be an array`);
  if (!Array.isArray(input.recipe.probes)) throw new Error(`Adapter ${input.adapter} install recipe probes must be an array`);

  const commands = [
    ...basePackageCommands(input.adapter, input.recipe.basePackages ?? []),
    ...input.recipe.commands.map((command, index) => normalizeCommand(command, `${input.adapter} install recipe commands[${index}]`)),
  ];
  const probes = input.recipe.probes.map((probe, index) => normalizeProbe(probe, `${input.adapter} install recipe probes[${index}]`));

  return removeUndefined({
    adapter: input.adapter,
    adapterVersion: input.adapterVersion,
    agentName: input.agentName,
    commands,
    probes,
    cacheKey: input.recipe.cacheKey,
  });
}

function basePackageCommands(adapter: string, packages: string[]): string[] {
  const normalized = [...new Set(packages.map((pkg, index) => normalizePackageName(pkg, `${adapter} install recipe basePackages[${index}]`)))].sort();
  if (normalized.length === 0) return [];
  return [`apt-get update && apt-get install -y --no-install-recommends ${normalized.join(' ')} && rm -rf /var/lib/apt/lists/*`];
}

function normalizeCommand(command: unknown, field: string): string {
  if (typeof command !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = command.trim();
  if (!trimmed) throw new Error(`${field} must not be empty`);
  return trimmed;
}

function normalizeProbe(probe: AdapterProbe, field: string): NormalizedAdapterProbe {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) throw new Error(`${field} must be an object`);
  if (!Array.isArray(probe.command) || probe.command.length === 0) throw new Error(`${field}.command must be a non-empty array`);
  const command = probe.command.map((part, index) => normalizeProbeCommandPart(part, `${field}.command[${index}]`));
  const expectedExitCode = probe.expectedExitCode ?? 0;
  if (!Number.isInteger(expectedExitCode) || expectedExitCode < 0) throw new Error(`${field}.expectedExitCode must be a non-negative integer`);
  return { command, expectedExitCode };
}

function normalizeProbeCommandPart(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function normalizePackageName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9+_.:-]+$/.test(value)) throw new Error(`${field} must be a package name`);
  return value;
}

async function imageExists(image: string, timeoutMs: number): Promise<boolean> {
  const result = await runDockerCommand(['image', 'inspect', image], timeoutMs);
  return result.exitCode === 0;
}

async function runProbes(image: string, probes: NormalizedAdapterProbe[], timeoutMs: number): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const containerName = probeContainerName(image, probe.command);
    const result = await runDockerCommand(['run', '--rm', '--name', containerName, image, ...probe.command], timeoutMs, containerName);
    results.push({
      command: probe.command,
      expectedExitCode: probe.expectedExitCode,
      exitCode: result.exitCode,
      pass: result.exitCode === probe.expectedExitCode && !result.errorMessage,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      errorMessage: result.errorMessage,
    });
  }
  return results;
}

function collectProbes(recipes: NormalizedInstallRecipe[]): NormalizedAdapterProbe[] {
  return recipes.flatMap((recipe) => recipe.probes);
}

function renderDockerfile(manifest: InstallManifest, cacheKey: string): string {
  const lines = [
    '# Generated by harness-evals. Do not edit.',
    `FROM ${manifest.baseImage}`,
    `LABEL org.harness-evals.image-schema="${manifest.schemaVersion}"`,
    `LABEL org.harness-evals.cache-key="${cacheKey}"`,
    'ENV HOME=/home/harness',
    'RUN mkdir -p "$HOME" /workspace /agent-config',
    'WORKDIR /workspace',
  ];

  for (const recipe of manifest.recipes) {
    for (const command of recipe.commands) lines.push(`RUN ${command}`);
  }

  return `${lines.join('\n')}\n`;
}

function computeCacheKey(manifest: InstallManifest): string {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex').slice(0, 32);
}

function compareSelectedAgents(a: ImageResolutionAgent, b: ImageResolutionAgent): number {
  return a.agent.adapter.localeCompare(b.agent.adapter)
    || a.agentName.localeCompare(b.agentName)
    || stableStringify(a.agent).localeCompare(stableStringify(b.agent));
}

function compareRecipes(a: NormalizedInstallRecipe, b: NormalizedInstallRecipe): number {
  return a.adapter.localeCompare(b.adapter)
    || a.agentName.localeCompare(b.agentName)
    || stableStringify(a).localeCompare(stableStringify(b));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function probeContainerName(image: string, command: string[]): string {
  return `harness-evals-probe-${createHash('sha1').update(`${image}\0${command.join('\0')}\0${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 24)}`;
}

function formatCommand(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(' ');
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? 'unavailable' : String(exitCode);
}

function firstOutputLine(...values: string[]): string {
  for (const value of values) {
    const line = value.trim().split('\n').find(Boolean);
    if (line) return line;
  }
  return 'no Docker output';
}

function runDockerCommand(args: string[], timeoutMs: number, containerName?: string): Promise<DockerCommandResult> {
  const command = ['docker', ...args];
  const startedAt = Date.now();
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;

  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    if (containerName) spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  }, timeoutMs);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      let stdout = Buffer.concat(stdoutChunks).toString('utf8');
      let stderr = Buffer.concat(stderrChunks).toString('utf8');
      let errorMessage: string | undefined;

      if (spawnError) {
        errorMessage = spawnError.message;
        stderr += `${stderr ? '\n' : ''}${spawnError.message}\n`;
      }

      if (timedOut) {
        errorMessage = `Timed out after ${timeoutMs}ms`;
        stderr += `${stderr ? '\n' : ''}${errorMessage}\n`;
      }

      resolve({ command, stdout, stderr, exitCode, durationMs: Date.now() - startedAt, timedOut, errorMessage });
    };

    child.on('error', (error) => settle(null, error));
    child.on('close', (code) => settle(code));
  });
}
