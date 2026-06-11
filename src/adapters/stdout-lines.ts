import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AgentEventInput } from './types.js';

/**
 * Iterate stdout lines without materializing the whole stream. Agent event
 * streams (pi/codex JSONL) can reach gigabytes — past V8's string limits — so
 * when the runner streamed stdout to disk, read the artifact line by line;
 * otherwise fall back to splitting the in-memory string.
 */
export async function* stdoutLines(input: Pick<AgentEventInput, 'stdout' | 'stdoutPath'>): AsyncGenerator<string> {
  if (input.stdoutPath) {
    const reader = createInterface({
      input: createReadStream(input.stdoutPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of reader) yield line;
    } finally {
      reader.close();
    }
    return;
  }
  for (const line of input.stdout.split(/\r?\n/)) yield line;
}
