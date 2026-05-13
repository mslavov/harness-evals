import { createRequire } from 'node:module';
import { extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdapterDeclaration } from '../config/schema.js';
import { pathExists, resolveProjectPath } from '../config/paths.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { commandAdapter } from './command.js';
import { cursorAdapter } from './cursor.js';
import { piAdapter } from './pi.js';
import type { AgentAdapter } from './types.js';

export interface AdapterRegistryInput {
  projectRoot: string;
  declarations: Record<string, AdapterDeclaration>;
  builtIns?: AgentAdapter[];
}

export interface AdapterRegistry {
  get(name: string): AgentAdapter | undefined;
  require(name: string): AgentAdapter;
  list(): AgentAdapterMetadata[];
}

export interface AgentAdapterMetadata {
  name: string;
  source: 'built-in' | 'project';
  module?: string;
  version?: string;
}

export const builtInAdapters: AgentAdapter[] = [
  commandAdapter,
  piAdapter,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
];

export async function createAdapterRegistry(input: AdapterRegistryInput): Promise<AdapterRegistry> {
  const adapters = new Map<string, AgentAdapter>();
  const metadata = new Map<string, AgentAdapterMetadata>();

  for (const adapter of input.builtIns ?? builtInAdapters) {
    registerAdapter(adapters, metadata, validateAdapterContract(adapter, 'built-in adapter'), { source: 'built-in' });
  }

  for (const [name, declaration] of Object.entries(input.declarations)) {
    const adapter = validateAdapterContract(await loadProjectAdapter(input.projectRoot, name, declaration), `adapters.${name}`);
    if (adapter.name !== name) {
      throw new Error(`Project adapter ${name} exported adapter named ${adapter.name}; adapter names must match declarations`);
    }
    registerAdapter(adapters, metadata, adapter, { source: 'project', module: declaration.module });
  }

  return new MapAdapterRegistry(adapters, metadata);
}

export function validateAdapterReferences(registry: AdapterRegistry, names: Iterable<string>): void {
  for (const name of names) registry.require(name);
}

export function validateAdapterContract(value: unknown, field = 'adapter'): AgentAdapter {
  if (!isRecord(value)) throw new Error(`${field} must export an adapter object`);
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error(`${field}.name must be a non-empty string`);
  if (value.version !== undefined && typeof value.version !== 'string') throw new Error(`${field}.version must be a string`);
  if (value.authEnvNames !== undefined && (!Array.isArray(value.authEnvNames) || !value.authEnvNames.every((name) => typeof name === 'string' && name.trim()))) {
    throw new Error(`${field}.authEnvNames must be an array of non-empty strings`);
  }
  if (typeof value.prepareStep !== 'function') throw new Error(`${field}.prepareStep must be a function`);
  if (typeof value.parseEvents !== 'function') throw new Error(`${field}.parseEvents must be a function`);
  if (value.getInstallRecipe !== undefined && typeof value.getInstallRecipe !== 'function') throw new Error(`${field}.getInstallRecipe must be a function`);
  if (value.applyMcpMocks !== undefined && typeof value.applyMcpMocks !== 'function') throw new Error(`${field}.applyMcpMocks must be a function`);
  if (value.complete !== undefined && typeof value.complete !== 'function') throw new Error(`${field}.complete must be a function`);
  return value as unknown as AgentAdapter;
}

async function loadProjectAdapter(projectRoot: string, name: string, declaration: AdapterDeclaration): Promise<unknown> {
  const specifier = await resolveAdapterImportSpecifier(projectRoot, declaration.module, `adapters.${name}.module`);
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = await import(specifier) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to import adapter ${name} from ${declaration.module}: ${errorMessage(error)}`);
  }

  return resolveAdapterExport(moduleExports, declaration, name);
}

async function resolveAdapterImportSpecifier(projectRoot: string, moduleSpecifier: string, field: string): Promise<string> {
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

function resolveAdapterExport(moduleExports: Record<string, unknown>, declaration: AdapterDeclaration, name: string): unknown {
  if (declaration.export) {
    if (!(declaration.export in moduleExports)) throw new Error(`Adapter ${name} module does not export ${declaration.export}`);
    return moduleExports[declaration.export];
  }

  if ('default' in moduleExports) return moduleExports.default;
  if ('adapter' in moduleExports) return moduleExports.adapter;
  throw new Error(`Adapter ${name} module must export default or adapter`);
}

function registerAdapter(
  adapters: Map<string, AgentAdapter>,
  metadata: Map<string, AgentAdapterMetadata>,
  adapter: AgentAdapter,
  details: Omit<AgentAdapterMetadata, 'name' | 'version'>,
): void {
  adapters.set(adapter.name, adapter);
  metadata.set(adapter.name, {
    name: adapter.name,
    version: adapter.version,
    ...details,
  });
}

class MapAdapterRegistry implements AdapterRegistry {
  constructor(
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly metadata: Map<string, AgentAdapterMetadata>,
  ) {}

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  require(name: string): AgentAdapter {
    const adapter = this.get(name);
    if (!adapter) throw new Error(`Unknown adapter: ${name}`);
    return adapter;
  }

  list(): AgentAdapterMetadata[] {
    return [...this.metadata.values()].map((entry) => ({ ...entry }));
  }
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
