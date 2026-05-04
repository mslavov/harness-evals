import type { MockRuntimePlan } from '../adapters/types.js';
import type { MockCallSummary } from '../events/types.js';

export interface MockFixture {
  name: string;
  description?: string;
  mocks: MockRule[];
  sourcePath: string;
}

export interface MockRule {
  id?: string;
  tool: string;
  match?: Record<string, string>;
  response?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}

export type MockSurface = 'cli' | 'mcp';

export interface MergedMockDeclarations {
  cli: Record<string, string>;
  mcp: Record<string, string>;
  strict: boolean;
  recordCalls: boolean;
}

export interface MockCallRecord extends MockCallSummary {
  surface: MockSurface;
  name: string;
  tool: string;
  input: Record<string, unknown>;
  matched: boolean;
  strict: boolean;
  timestamp: string;
  command?: string;
  serverName?: string;
  fixtureName?: string;
  fixturePath?: string;
  fixture?: string;
  ruleId?: string;
  exitCode?: number;
  error?: string;
  args?: unknown;
  isError?: boolean;
}

export interface StagedMockRuntimePlan extends MockRuntimePlan {
  metadata: MockRuntimePlan['metadata'] & {
    mocks?: {
      strict: boolean;
      recordCalls: boolean;
      cli?: Record<string, StagedMockSurfaceMetadata>;
      mcp?: Record<string, StagedMockSurfaceMetadata>;
      applyMcpMocks?: unknown;
    };
  };
}

export interface StagedMockSurfaceMetadata {
  fixture: string;
  fixturePath: string;
  callLogPath?: string;
  wrapperPath?: string;
  planPath?: string;
}
