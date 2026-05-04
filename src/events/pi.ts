import { parseJsonl } from './jsonl.js';
import type { AgentEventsSummary, ToolCallSummary } from './types.js';

interface MutableToolCall extends ToolCallSummary {
  id?: string;
}

export function parsePiEvents(stdout: string): AgentEventsSummary {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
