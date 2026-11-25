/**
 * What the screens show of the host's own sign-in of a backend (TODO #426):
 * kept by Timon or the CLI's own, and what can be done about it. Never a path,
 * never a secret; who it is signed in as only goes to the operator (the
 * Providers screen narrows it away below the `full` level).
 */
import { hostSignInSupport, hostTokenStored } from './account-login.js';
import { getHostSignIn } from './host-sign-in.js';
import { providerSignedIn } from './sign-in-state.js';

/** What the screen shows of the host's sign-in. Who it is signed in as is the operator's to read. */
export type HostSignInView = {
  backend: string;
  /** The sign-in Timon keeps in its own folder, else the CLI's own (the terminal's session). */
  kept: boolean;
  identity: string | null;
  /** Can be signed in from the browser. */
  browser: boolean;
  /** A long-lived token can be minted in the app; `stored`: one is kept. */
  token: { stored: boolean } | null;
  /**
   * Only that token runs the host's launches: the daemon is a service outside
   * the user's session, where the CLI's sign-in (kept or the terminal's) cannot
   * be read. `browser` is then false.
   */
  tokenOnly: boolean;
  /** Whether the backend is signed in at all, as far as the daemon knows (`null`: it cannot tell). */
  signedIn: boolean | null;
};

/** The view of `backend`, null when its provider does not let Timon keep the host's sign-in. */
export function hostSignInView(backend: string): HostSignInView | null {
  const support = hostSignInSupport(backend);
  if (!support) return null;
  const kept = getHostSignIn(backend);
  const stored = support.token ? hostTokenStored(backend) : null;
  return {
    backend,
    kept: kept !== undefined,
    identity: kept?.identityLabel ?? null,
    browser: support.browser,
    token: stored === null ? null : { stored },
    tokenOnly: support.tokenOnly,
    signedIn: providerSignedIn(backend),
  };
}
