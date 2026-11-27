/**
 * The one status line of a provider (`docs/PROVIDERS-OVERVIEW.md`).
 *
 * Pure, so the screens and the tests read the same verdict: every input is a
 * fact the aggregator already measured, the order below is the only decision.
 */

export const PROVIDER_STATUSES = [
  'disabled', 'blocked', 'not-installed', 'needs-authorization', 'connected', 'not-connected', 'available',
] as const;
export type ProviderStatus = typeof PROVIDER_STATUSES[number];

export type ProviderStatusInput = {
  /** The person switched it off: the plugin is disabled, or every backend it brings is. */
  disabled: boolean;
  /** Something the person cannot fix by signing in: a program refused by policy, an install whose files changed. */
  refused: boolean;
  /** A program it needs is not on this machine. */
  programMissing: boolean;
  /** A program is there but the operator has not accepted it yet (new, moved, or withdrawn). */
  needsAuthorization: boolean;
  /** It did not load for another reason: plugin failed or skipped, dialect missing. */
  failed: boolean;
  /** The host's own sign-in: `false` only when the daemon KNOWS it is signed out. */
  signedIn: boolean | null;
  /** A subscription account signed in through Timon and not waiting for a new sign-in. */
  accountConnected: boolean;
  secretRequired: boolean;
  secretPresent: boolean;
  /** At least one of its backends is in the registry's active set. */
  usable: boolean;
};

/**
 * First match wins. What the person must do first comes first: turning it back
 * on, then what blocks for good, then installing, then authorizing, and only
 * then the sign-in. A refusal outranks a missing program because installing
 * would not lift it; a missing program outranks a failed plugin because a
 * provider plugin fails to mount precisely when its program is absent.
 * A missing key comes before any sign-in: a provider that reads a key runs on
 * nothing else, so a turn that once worked or a session of the CLI it borrows
 * cannot stand for it. Then `connected` outranks `not-connected`: one
 * signed-in account is enough for a mission to run, even when the host itself
 * is signed out.
 */
export function providerStatus(input: ProviderStatusInput): ProviderStatus {
  if (input.disabled) return 'disabled';
  if (input.refused) return 'blocked';
  if (input.programMissing) return 'not-installed';
  if (input.needsAuthorization) return 'needs-authorization';
  if (input.failed) return 'blocked';
  if (input.secretRequired && !input.secretPresent) return 'not-connected';
  if (input.signedIn === true || input.accountConnected) return 'connected';
  if (input.secretRequired && input.secretPresent && input.usable) return 'connected';
  if (input.signedIn === false || (input.secretRequired && !input.secretPresent) || !input.usable) return 'not-connected';
  return 'available';
}
