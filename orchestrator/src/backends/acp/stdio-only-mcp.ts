/**
 * The codecs of the daemon's ACP session driver, which declares only the stdio MCP servers of a
 * mission in `session/new` (`serializeAcpMcpServers`): an HTTP server handed to it never reaches
 * the agent. The registry reads the mark when a provider registers (`backendTakesHttpMcp`), so
 * the daemon does not turn a stdio server into an HTTP one for such an agent (TODO #1071).
 *
 * The CODEC carries the mark, not the definition: a plugin spreads the definition to add a member
 * (`{ ...definition, usage }`), which keeps the codec as it is. Leaf module: the registry and the
 * ACP provider both import it without importing each other.
 */

const stdioOnly = new WeakSet<object>();

export function markStdioOnlyMcpCodec<T extends object>(codec: T): T {
  stdioOnly.add(codec);
  return codec;
}

export function isStdioOnlyMcpCodec(codec: unknown): boolean {
  return typeof codec === 'object' && codec !== null && stdioOnly.has(codec);
}
