/**
 * The arguments of a stdio MCP server that carry a credential (TODO #1181):
 * `--api-key xyz`, `--token=xyz`, `--header "Authorization: Bearer xyz"`.
 * `mcp.ts` seals their value into the vault, as it does for the variables,
 * shows them `***` to every reader and hands them to the daemon's bridge only.
 *
 * Recognised by the flag or the header that names them, never by the look of
 * the value: a value alone says nothing. A flag that names a file, a path, a
 * type or an url (`--key-file`, `--token-url`) is not a credential.
 */

/** What a sealed value reads as, inside its argument. */
export const ARG_SECRET_MASK = '***';

const SECRET_WORDS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'passphrase',
  'credential', 'credentials', 'bearer', 'auth', 'authorization', 'cookie', 'pat',
]);
// A word ending like this is one too: `accesstoken`, `clientsecret`, `apikey`.
const SECRET_ENDING = /(?:token|secret|password|apikey)$/;
// The last word of a flag that names something else than the credential itself.
const NOT_SECRET_LAST = new Set([
  'file', 'path', 'dir', 'type', 'mode', 'url', 'uri', 'endpoint', 'name', 'id',
  'env', 'var', 'header', 'length', 'ttl', 'expiry', 'expires', 'store', 'cmd', 'command',
]);

/** Whether a flag or header name (`--api-key`, `X-Api-Key`) names a credential. */
export function namesSecret(name: string): boolean {
  const words = name.replace(/^-+/, '').toLowerCase().split(/[-_.]/).filter(Boolean);
  if (!words.length || words[0] === 'no') return false;
  if (NOT_SECRET_LAST.has(words[words.length - 1]!)) return false;
  return words.some((word) => SECRET_WORDS.has(word) || SECRET_ENDING.test(word));
}

const BARE_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FLAG_WITH_VALUE = /^(--?[A-Za-z0-9][A-Za-z0-9_.-]*=)([\s\S]+)$/;
const HEADER = /^([A-Za-z][A-Za-z0-9-]*:[ \t]*)([\s\S]+)$/;

/**
 * Where the credential of `args[i]` starts: `prefix` is what stays in clear
 * before it (`--token=`, `Authorization: `, or nothing when the whole argument
 * is the value of the flag before it). `null`: not a credential.
 */
export function secretArgSpot(args: readonly string[], i: number): { prefix: string } | null {
  const arg = args[i];
  if (!arg) return null;
  const withValue = FLAG_WITH_VALUE.exec(arg);
  if (withValue) return namesSecret(withValue[1]!.slice(0, -1)) ? { prefix: withValue[1]! } : null;
  const header = HEADER.exec(arg);
  if (header && !arg.startsWith('-')) {
    const name = header[1]!.replace(/:[ \t]*$/, '');
    if (namesSecret(name)) return { prefix: header[1]! };
  }
  const flag = i > 0 ? args[i - 1]! : '';
  if (BARE_FLAG.test(flag) && namesSecret(flag) && (!arg.startsWith('-') || arg === ARG_SECRET_MASK)) return { prefix: '' };
  return null;
}

/** Whether any argument carries a credential. */
export function hasSecretArgs(args: readonly string[] | undefined): boolean {
  return (args ?? []).some((_, i) => secretArgSpot(args!, i) !== null);
}

/**
 * The arguments as a reader is shown them: each credential, and each index in
 * `sealed` (held by the vault), worth `***` after its prefix.
 */
export function maskSecretArgs(args: readonly string[] | undefined, sealed: ReadonlySet<number> = new Set()): string[] {
  const list = [...(args ?? [])];
  return list.map((arg, i) => {
    if (sealed.has(i)) return arg;
    const spot = secretArgSpot(list, i);
    return spot ? spot.prefix + ARG_SECRET_MASK : arg;
  });
}
