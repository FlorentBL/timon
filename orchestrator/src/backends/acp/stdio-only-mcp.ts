/**
 * The codecs of the daemon's ACP session driver, which declares an HTTP MCP server in `session/new`
 * only to an agent that announced `mcpCapabilities.http` at `initialize` (`serializeAcpMcpServers`):
 * opencode does, Hermes and agy do not. That answer comes once the agent runs, after the daemon has
 * decided how to launch the user's servers, so the registry reads the mark when a provider registers
 * (`backendTakesHttpMcp`) and the daemon never turns a stdio server into an HTTP one for such an
 * agent (TODO #1071): the agent keeps starting the server itself, which works whatever it announces.
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
