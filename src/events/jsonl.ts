export function parseJsonl(input: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Non-JSON lines are handled by agent-specific parsers when needed.
    }
  }

  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
