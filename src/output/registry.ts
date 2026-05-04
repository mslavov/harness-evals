import { createRequire } from 'node:module';
import { extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathExists, resolveProjectPath } from '../config/paths.js';
import { createFileOutputProvider } from './file-provider.js';
import type { VisualizationConfig } from '../config/schema.js';
import type { ConfiguredOutputProvider } from './dispatcher.js';
import type { OutputProvider, OutputProviderConfig, OutputProviderFactory } from './types.js';

export interface OutputProviderRegistryInput {
  projectRoot: string;
  outputRoot: string;
  providers: readonly OutputProviderConfig[];
  visualization?: VisualizationConfig;
}

export interface CreateOutputProvidersInput {
  runId: string;
  runDir?: string;
  scenarioId?: string;
  agentName?: string;
}

export interface OutputProviderRegistry {
  create(input: CreateOutputProvidersInput): ConfiguredOutputProvider[];
  list(): OutputProviderMetadata[];
}

export interface OutputProviderMetadata {
  type: string;
  source: 'built-in' | 'project';
  module?: string;
}

type ProviderDefinition = {
  config: OutputProviderConfig;
  metadata: OutputProviderMetadata;
  create(input: CreateOutputProvidersInput): OutputProvider;
};

export async function createOutputProviderRegistry(input: OutputProviderRegistryInput): Promise<OutputProviderRegistry> {
  const configs = input.providers.length > 0 ? input.providers : [{ type: 'file' }];
  const definitions: ProviderDefinition[] = [];

  for (const [index, config] of configs.entries()) {
    if (config.type === 'file' && !config.module) {
      definitions.push({
        config,
        metadata: { type: 'file', source: 'built-in' },
        create: (runInput) => createFileOutputProvider({
          projectRoot: input.projectRoot,
          outputRoot: input.outputRoot,
          runDir: runInput.runDir,
          visualization: input.visualization,
        }),
      });
      continue;
    }

    const exported = await loadProjectProvider(input.projectRoot, config, index);
    const create = isOutputProviderFactory(exported)
      ? () => createProviderFromFactory(exported, config, index)
      : createProviderFromObject(exported, config, index);

    definitions.push({
      config,
      metadata: { type: config.type, source: 'project', module: config.module },
      create,
    });
  }

  return new LoadedOutputProviderRegistry(definitions);
}

export function validateOutputProviderContract(value: unknown, field = 'output provider'): OutputProvider {
  if (!isRecord(value)) throw new Error(`${field} must export an output provider object`);
  if (typeof value.type !== 'string' || !value.type.trim()) throw new Error(`${field}.type must be a non-empty string`);
  if (typeof value.initialize !== 'function') throw new Error(`${field}.initialize must be a function`);
  if (typeof value.write !== 'function') throw new Error(`${field}.write must be a function`);
  if (typeof value.finalize !== 'function') throw new Error(`${field}.finalize must be a function`);
  if (value.writeBlob !== undefined && typeof value.writeBlob !== 'function') throw new Error(`${field}.writeBlob must be a function`);
  return value as unknown as OutputProvider;
}

class LoadedOutputProviderRegistry implements OutputProviderRegistry {
  constructor(private readonly definitions: ProviderDefinition[]) {}

  create(_input: CreateOutputProvidersInput): ConfiguredOutputProvider[] {
    return this.definitions.map((definition) => ({
      provider: definition.create(_input),
      config: definition.config.config ?? {},
    }));
  }

  list(): OutputProviderMetadata[] {
    return this.definitions.map((definition) => ({ ...definition.metadata }));
  }
}

async function loadProjectProvider(projectRoot: string, config: OutputProviderConfig, index: number): Promise<unknown> {
  if (!config.module) throw new Error(`output.providers[${index}].module is required for custom provider type ${config.type}`);
  const specifier = await resolveProviderImportSpecifier(projectRoot, config.module, `output.providers[${index}].module`);
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = await import(specifier) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to import output provider ${config.type} from ${config.module}: ${errorMessage(error)}`);
  }

  return resolveProviderExport(moduleExports, config, index);
}

async function resolveProviderImportSpecifier(projectRoot: string, moduleSpecifier: string, field: string): Promise<string> {
  if (isProjectPathSpecifier(moduleSpecifier)) {
    return pathToFileURL(resolveProjectPath(projectRoot, moduleSpecifier, field)).href;
  }

  if (couldBeProjectSubpath(moduleSpecifier)) {
    const candidate = resolveProjectPath(projectRoot, moduleSpecifier, field);
    if (await pathExists(candidate)) return pathToFileURL(candidate).href;
  }

  const requireFromProject = createRequire(join(projectRoot, 'harness-evals.yaml'));
  try {
    return pathToFileURL(requireFromProject.resolve(moduleSpecifier)).href;
  } catch (error) {
    throw new Error(`${field} could not be resolved as a project file or package specifier: ${moduleSpecifier} (${errorMessage(error)})`);
  }
}

function resolveProviderExport(moduleExports: Record<string, unknown>, config: OutputProviderConfig, index: number): unknown {
  if (config.export) {
    if (!(config.export in moduleExports)) throw new Error(`Output provider ${config.type} module does not export ${config.export}`);
    return moduleExports[config.export];
  }

  if ('default' in moduleExports) return moduleExports.default;
  if ('createProvider' in moduleExports) return moduleExports.createProvider;
  if ('provider' in moduleExports) return moduleExports.provider;
  throw new Error(`Output provider ${config.type} module must export default, createProvider, or provider`);
}

function createProviderFromObject(exported: unknown, config: OutputProviderConfig, index: number): () => OutputProvider {
  const provider = validateOutputProviderContract(exported, `output.providers[${index}]`);
  validateProviderType(provider, config.type);
  return () => cloneOutputProvider(provider);
}

function createProviderFromFactory(factory: OutputProviderFactory, config: OutputProviderConfig, index: number): OutputProvider {
  let provider: unknown;
  try {
    provider = factory();
  } catch (error) {
    throw new Error(`Output provider ${config.type} factory failed: ${errorMessage(error)}`);
  }

  const validated = validateOutputProviderContract(provider, `output.providers[${index}] factory result`);
  validateProviderType(validated, config.type);
  return validated;
}

function cloneOutputProvider(provider: OutputProvider): OutputProvider {
  const clone = Object.create(Object.getPrototypeOf(provider)) as OutputProvider;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(provider));
  return clone;
}

function validateProviderType(provider: OutputProvider, declaredType: string): void {
  if (provider.type !== declaredType) {
    throw new Error(`Output provider ${declaredType} exported provider type ${provider.type}; provider types must match declarations`);
  }
}

function isOutputProviderFactory(value: unknown): value is OutputProviderFactory {
  return typeof value === 'function';
}

function isProjectPathSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith('.') || isAbsolute(moduleSpecifier) || moduleSpecifier.includes('\\') || Boolean(extname(moduleSpecifier));
}

function couldBeProjectSubpath(moduleSpecifier: string): boolean {
  return !moduleSpecifier.startsWith('@') && moduleSpecifier.includes('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
