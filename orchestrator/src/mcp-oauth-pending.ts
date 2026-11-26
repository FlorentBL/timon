/**
 * MCP authorizations waiting for their callback, kept across a restart of the
 * daemon (TODO #1199).
 *
 * A flow holds the PKCE `code_verifier`, a secret: the row seals the whole
 * flow under the vault's master key, bound to the row's own key, and listed
 * in `SEALED_COLUMNS` so a key rotation carries it over. The row is keyed by
 * a hash of the `state`, never the state itself: whoever reads the database
 * gets neither half of the credential. Only what a refused callback needs to
 * link back to its app stays in clear (the server id, the app origin and
 * page), and it is no secret.
 *
 * Rows live as long as the flow (`PENDING_TTL_MS` in `oauth.ts`): an expired
 * one is deleted at the next read or write, a used one at once. Without a
 * vault (module off, master key unreadable) nothing is written: the flow
 * stays in memory only, as it did before, and a restart loses it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from './db.js';
import { isSealed } from './secrets/box.js';
import { vaultEnabled } from './secrets/availability.js';
import { mcpOAuthPendingIdentity } from './secrets/sealed-columns.js';
import { openWithVault, sealWithVault } from './secrets/store.js';
import type { OAuthClient, OAuthMetadata } from './plugins/contract/mcp-servers.js';

/** What a pending flow carries, as `oauth.ts` hands it over. */
export type PendingFlow = {
  mcp_id: string;
  code_verifier: string;
  redirect_uri: string;
  metadata: OAuthMetadata;
  client: OAuthClient;
  created_at: number;
  return_to?: string;
  return_path?: string;
};

/** The clear part of a row: enough to link a refused callback back to its app. */
export type PendingFlowHeader = { mcp_id: string; created_at: number; return_to?: string; return_path?: string };

export type TakenFlow =
  | { kind: 'flow'; flow: PendingFlow }
  /** A row the vault cannot open any more (key lost, vault switched off since). */
  | { kind: 'unreadable'; header: PendingFlowHeader };

const flowSchema = z.object({
  mcp_id: z.string().min(1),
  code_verifier: z.string().min(1),
  redirect_uri: z.string().min(1),
  metadata: z.object({
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    registration_endpoint: z.string().optional(),
    scopes_supported: z.array(z.string()).optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
  }),
  client: z.object({ client_id: z.string(), client_secret: z.string().optional() }),
  created_at: z.number(),
  return_to: z.string().optional(),
  return_path: z.string().optional(),
});

type Row = {
  state_hash: string;
  mcp_id: string;
  created_at: number;
  return_to: string | null;
  return_path: string | null;
  flow: string;
};

let schemaReady = false;

/** The feature owns its table; idempotent, run before the first statement. */
function ensureSchema(): void {
  if (schemaReady) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
  state_hash TEXT PRIMARY KEY,
  mcp_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  return_to TEXT,
  return_path TEXT,
  flow TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_pending_created ON mcp_oauth_pending(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_pending_mcp ON mcp_oauth_pending(mcp_id);
`);
  schemaReady = true;
}

/** The row key of a state: a database read never yields a state a callback would accept. */
export function pendingStateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function headerOf(row: Pick<Row, 'mcp_id' | 'created_at' | 'return_to' | 'return_path'>): PendingFlowHeader {
  return {
    mcp_id: row.mcp_id,
    created_at: row.created_at,
    ...(row.return_to ? { return_to: row.return_to } : {}),
    ...(row.return_path ? { return_path: row.return_path } : {}),
  };
}

// Said once per process: a vault that is off stays off for every flow.
let memoryOnlyWarned = false;

/**
 * Seals and stores a flow, keeping at most `max` rows (the oldest go first).
 * Returns false when the vault cannot take it: the caller keeps it in memory.
 */
export function savePendingFlow(state: string, flow: PendingFlow, max: number): boolean {
  let why: string | null = null;
  let envelope = '';
  const hash = pendingStateHash(state);
  if (!vaultEnabled()) {
    why = 'the secrets vault is off';
  } else {
    try {
      envelope = sealWithVault(JSON.stringify(flow), mcpOAuthPendingIdentity(hash));
    } catch {
      why = 'the secrets vault is unavailable';
    }
  }
  if (why) {
    if (!memoryOnlyWarned) {
      memoryOnlyWarned = true;
      console.warn(`[mcp-oauth] pending authorizations are kept in memory only (${why}): a restart loses them`);
    }
    return false;
  }
  try {
    ensureSchema();
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO mcp_oauth_pending (state_hash, mcp_id, created_at, return_to, return_path, flow)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(hash, flow.mcp_id, flow.created_at, flow.return_to ?? null, flow.return_path ?? null, envelope);
      db.prepare(`DELETE FROM mcp_oauth_pending WHERE state_hash NOT IN (
        SELECT state_hash FROM mcp_oauth_pending ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(max);
    })();
    return true;
  } catch (error) {
    // The flow still works from memory; the error is the database's, it quotes no value of the row.
    console.warn(`[mcp-oauth] a pending authorization could not be stored (${(error as Error).name}): a restart loses it`);
    return false;
  }
}

/**
 * The flow of `state`, removed in the same statement: a state answers one
 * callback, whichever process issued it. `null` when no row holds it.
 */
export function takePendingFlow(state: string): TakenFlow | null {
  ensureSchema();
  const hash = pendingStateHash(state);
  const row = db.prepare(`DELETE FROM mcp_oauth_pending WHERE state_hash = ?
    RETURNING state_hash, mcp_id, created_at, return_to, return_path, flow`).get(hash) as Row | undefined;
  if (!row) return null;
  if (!vaultEnabled() || !isSealed(row.flow)) return { kind: 'unreadable', header: headerOf(row) };
  try {
    const parsed = flowSchema.safeParse(JSON.parse(openWithVault(row.flow, mcpOAuthPendingIdentity(hash))));
    if (!parsed.success || parsed.data.mcp_id !== row.mcp_id) return { kind: 'unreadable', header: headerOf(row) };
    return { kind: 'flow', flow: parsed.data };
  } catch {
    // A vault error names no value, but nothing of it is needed: the flow is lost either way.
    return { kind: 'unreadable', header: headerOf(row) };
  }
}

/** Forgets the row of a state, if any: the flow was answered from memory. */
export function dropPendingFlow(state: string): void {
  ensureSchema();
  db.prepare(`DELETE FROM mcp_oauth_pending WHERE state_hash = ?`).run(pendingStateHash(state));
}

/** Deletes the rows created before `cutoff` and returns their clear part, keyed by state hash. */
export function reapPendingFlows(cutoff: number): { hash: string; header: PendingFlowHeader }[] {
  ensureSchema();
  const rows = db.prepare(`DELETE FROM mcp_oauth_pending WHERE created_at < ?
    RETURNING state_hash, mcp_id, created_at, return_to, return_path`).all(cutoff) as Omit<Row, 'flow'>[];
  return rows.map((row) => ({ hash: row.state_hash, header: headerOf(row) }));
}

/** Forgets every flow of a server. */
export function forgetPendingFlows(mcpId: string): void {
  ensureSchema();
  db.prepare(`DELETE FROM mcp_oauth_pending WHERE mcp_id = ?`).run(mcpId);
}

/** The state hashes of every stored flow. */
export function pendingFlowHashes(): string[] {
  ensureSchema();
  return (db.prepare(`SELECT state_hash FROM mcp_oauth_pending`).all() as { state_hash: string }[]).map((r) => r.state_hash);
}

/** Tests: the raw rows, to prove what is sealed and what is not. */
export function pendingFlowRowsForTests(): Row[] {
  ensureSchema();
  return db.prepare(`SELECT * FROM mcp_oauth_pending`).all() as Row[];
}

/** Tests: an empty table, as a fresh install has. */
export function clearPendingFlowsForTests(): void {
  ensureSchema();
  db.prepare(`DELETE FROM mcp_oauth_pending`).run();
}
