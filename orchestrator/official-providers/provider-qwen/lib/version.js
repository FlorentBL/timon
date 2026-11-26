// @ts-check
/**
 * The oldest Qwen Code this plugin starts (the profile's `minCliVersion`). The ACP runtime does not
 * read that field: a provider checks it in its own launch, as Pi does (`provider-pi`). Below it, the
 * command line this plugin passes is not one the CLI knows (`--acp` was `--experimental-acp`), and
 * the mission would fail on a usage error nobody can act on from the chat.
 *
 * @typedef {import('@timon-ai/sdk/provider').NativeProviderDefinition} NativeProviderDefinition
 * @typedef {import('@timon-ai/sdk/provider').ProviderServices} ProviderServices
 */

/** @param {string} version */
export function parseVersion(version) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {number[]} a @param {number[]} b */
function olderThan(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * `definition` whose launch first refuses a Qwen Code older than the profile's `minCliVersion`, with
 * the command that updates it. An unreadable version is not a verdict: the launch goes ahead and
 * fails on its own terms. A version accepted once is not asked again.
 *
 * @param {NativeProviderDefinition} definition
 * @param {Pick<ProviderServices, 'binary'>} services
 * @param {string} binaryName
 * @returns {NativeProviderDefinition}
 */
export function withMinimumVersion(definition, services, binaryName) {
  /** @type {string | null} */
  let accepted = null;
  return {
    ...definition,
    async launch(spawn, profile) {
      const min = profile.minCliVersion ? parseVersion(profile.minCliVersion) : null;
      if (min && accepted !== profile.minCliVersion) {
        let version = null;
        try {
          version = parseVersion((await services.binary.version(binaryName)) ?? '');
        } catch {
          version = null;
        }
        if (version && olderThan(version, min)) {
          throw new Error(`Qwen Code ${version.join('.')} is older than ${profile.minCliVersion}, the oldest version Timon drives. `
            + 'Update it (npm install -g @qwen-code/qwen-code@latest, or its installer again) and send the message again.');
        }
        if (version) accepted = profile.minCliVersion;
      }
      return definition.launch(spawn, profile);
    },
  };
}
