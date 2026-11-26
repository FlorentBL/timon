/**
 * The account this document is signed in as, announced by
 * `WorkspaceLayoutProvider` each time it drops its per-account memory (on the
 * login page, and when a resolved route names another owner).
 *
 * A module store that keeps a value read from the daemon outlives the account
 * it was read for: it subscribes here and empties itself when the owner
 * changes, as `forgetStoredLayouts` does for the layout seeds.
 */

type Listener = (owner: string | null) => void;

const listeners = new Set<Listener>();
/** The last account announced: a store that subscribes after the announcement still learns it. */
let announced: string | null = null;

export function currentAccount(): string | null {
  return announced;
}

export function onAccountChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Calls `listener` each time the signed-in account becomes another one, or
 * signs out: never for the first account named, nor when the same one is
 * announced again. The listener learns no id, so a plugin can hold it
 * (`@timon/ui` `onAccountChange`, client API 20) without reading who is
 * signed in. Returns the unsubscribe.
 */
export function onAccountSwitch(listener: () => void): () => void {
  let followed = announced;
  return onAccountChange((owner) => {
    const switched = followed !== null && owner !== followed;
    followed = owner;
    if (switched) listener();
  });
}

export function announceAccount(owner: string | null): void {
  announced = owner;
  for (const listener of listeners) listener(owner);
}
