import { daemonMessageText } from '@/lib/api-error';

/**
 * The warnings of an agent save (`POST /api/agents`), in the reader's language:
 * a shell pre-allow the claude CLI drops in auto mode, or may drop when no mode
 * is set. The daemon sends the English (`warnings`, what the CLI and the MCP
 * print) and, in the same order, its code (`warning_messages`); a code this
 * screen cannot say falls back to the English. Read defensively: the save has
 * happened, a malformed answer must not turn it into a failure.
 */
export function agentSaveWarnings(body: unknown): string[] {
  const answer = (body && typeof body === 'object' ? body : {}) as { warnings?: unknown; warning_messages?: unknown };
  if (!Array.isArray(answer.warnings)) return [];
  const codes = Array.isArray(answer.warning_messages) ? answer.warning_messages : [];
  return answer.warnings.flatMap((english: unknown, index: number) =>
    typeof english === 'string' ? [daemonMessageText(codes[index], english)] : []);
}
