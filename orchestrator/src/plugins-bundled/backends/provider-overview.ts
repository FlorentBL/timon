/**
 * The providers as the person sees them (`docs/PROVIDERS-OVERVIEW.md`): one
 * record per provider, gathered from the sources that already own each fact —
 * the backend registry, the AI CLI cards, the pinned binaries, the provider
 * plugins' program authorizations, the ACP registry, the subscription
 * accounts. Nothing here measures anything itself: it groups and it decides
 * the one status line (`provider-status.ts`).
 *
 * What is a provider:
 * - a provider plugin, with the backends it brings. A plugin that brings
 *   several backends (the ACP agents plugin: opencode, Hermes…) is one
 *   provider per backend: each is a distinct program the person installs and
 *   signs in to on its own, under the name the model picker shows for it;
 * - a backend the person added by hand (a file under `~/.timon/backends/`),
 *   a file Timon could not read included: blocked, with the reason why. A
 *   file whose id is taken, or whose name is no id at all, is listed under its
 *   file name and reaches no backend: the id belongs to someone else;
 * - an agent installed from the ACP registry;
 * - a profile nobody registered (a built-in kept by the product itself).
 */
import { hostSignInView, type HostSignInView } from '../../backends/host-sign-in-view.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BackendProfile } from '../../backends/types.js';
import { isRemoteDialect } from '../../backends/types.js';
import {
  backendTakesAccounts, getDialect, inactiveProfiles, installedProfiles, profileDeclarations, registeredBackendOwners,
} from '../../backends/registry.js';
import { backendCatalog, tryDefaultBackendName, type CatalogBackend } from '../../backends/index.js';
import { binaryPinStatuses, type BinaryPinStatus } from '../../backends/binary-pins.js';
import { providerSignedIn } from '../../backends/sign-in-state.js';
import { listBackendAccountsFor } from '../../backends/accounts.js';
import { LOCAL_BACKEND_ID_RE, listLocalBackends, secretNamesOf } from '../../backends/local-profiles.js';
import { probeProfileEnv } from '../../backends/credentials.js';
import { dbApi, type BackendOverlayRow } from '../../db.js';
import { providerClis, setupBackends, type SetupBackend } from '../../onboarding.js';
import { providerBinaryRequests, type ProviderBinaryRequest } from '../../plugins/exec-grants.js';
import { canonicalPath } from '../../plugins/policy.js';
import type { PluginStatus } from '../../plugins/loader.js';
import { whichBin } from '../../doctor.js';
import { listAgents } from '../../agent.js';
import { config } from '../../config/load.js';
import { ACP_REGISTRY_OWNER, profileIdOf, type AgentView } from '../../providers/acp-registry/service.js';
import type { DbViewer } from '../../users/identity.js';
import { publicAccount } from './account-routes.js';
import { providerStatus, type ProviderStatus } from './provider-status.js';

export type ProviderOrigin = 'built-in' | 'user' | 'catalog' | 'plugin';
/** Same vocabulary as the provider plugins' screen (`app/src/lib/providers.ts`, `binaryAction`). */
export type ProgramAuthorization = 'ready' | 'authorize' | 'install' | 'refused';

export type ProviderBackendView = {
  id: string;
  label: string;
  /** In the registry's active set: a mission can be launched on it now. */
  active: boolean;
  /** Switched off in Settings. */
  disabled: boolean;
  /** Why it is not active, in the registry's words. Never a secret value. */
  reason: string | null;
  modelCount: number;
  defaultModel: string | null;
  /** The instance's default backend. */
  isDefault: boolean;
  /** Reached over the network: nothing runs on this machine for it. */
  remote: boolean;
};

export type ProviderProgramView = {
  /** Canonical program name (the first of its names). */
  name: string;
  /** What a launch runs, as the daemon resolves it (`host.binaries` pin first). */
  path: string | null;
  /** The file behind `path` when it is a link; `null` when `path` is the file itself. */
  linkTarget: string | null;
  /** Resolved through `host.binaries`. */
  pinned: boolean;
  /** The `host.binaries` key a path is pinned under for it; `null` when nothing can be pinned (not a backend's CLI). */
  pinKey: string | null;
  /** The pinned value as configured, even when it no longer resolves. */
  pin: string | null;
  version: string | null;
  latest: string | null;
  updateAvailable: boolean;
  unsupportedVersion: boolean;
  /** Found inside a desktop application rather than installed on its own. */
  bundled: boolean;
  installable: boolean;
  installCommand: string | null;
  installDocs: string | null;
  /** For a program a plugin launches: the operator's authorization. `null` when none is asked. */
  authorization: ProgramAuthorization | null;
  /** Why the policy refuses it, when it does. */
  refusedReason: string | null;
};

export type ProviderAccountView = ReturnType<typeof publicAccount>;

export type ProviderOverview = {
  id: string;
  /** The name the model picker shows. */
  name: string;
  brand: string | null;
  /** A pictogram chosen by the user, or a logo the provider declared (`data:` URI). Wins over `brand`. */
  icon: string | null;
  origin: ProviderOrigin;
  /** The plugin that brings it: its own settings and sections hang on this id. */
  pluginId: string | null;
  plugin: { id: string; label: string; version: string; state: PluginStatus['state']; reason: string | null; signed: boolean; builtin: boolean } | null;
  /** Installed from the ACP registry. */
  catalogAgent: { id: string; version: string; latest: string | null; state: string; integrity: string; updateAvailable: boolean } | null;
  enabled: boolean;
  isDefault: boolean;
  backends: ProviderBackendView[];
  modelCount: number;
  /** Agents whose backend is one of these, the implicit default counted for the default provider. */
  agentCount: number;
  connection: {
    signedIn: boolean | null;
    signInCommand: string | null;
    signInThen: string | null;
    acceptsAccounts: boolean;
    accounts: ProviderAccountView[];
    /** The host's own sign-in, when Timon can keep it (`host-sign-in-view.ts`); null otherwise. */
    host: HostSignInView | null;
  };
  /** Vault entries its backends read: names only, never a value. */
  secret: { required: boolean; present: boolean; names: string[] };
  programs: ProviderProgramView[];
  status: ProviderStatus;
  updateAvailable: boolean;
};

export type ProvidersOverview = {
  providers: ProviderOverview[];
  defaultBackend: string | null;
};

export type OverviewSources = {
  /** The plugin loader's live list; empty without a loader. */
  plugins: readonly PluginStatus[];
  /** Agents installed from the ACP registry. */
  acpAgents: readonly AgentView[];
  viewer: DbViewer;
};

const LOCAL_FILE_OWNER = 'local-file';

/** What a provider plugin's manifest declares of one backend: its id and the names of its program. */
const DeclaredBackend = z.object({
  id: z.string().min(1),
  rank: z.number().finite().optional(),
  binary: z.object({ names: z.array(z.string().min(1)) }).passthrough().optional(),
}).passthrough();

function declaredBackends(status: PluginStatus): { id: string; names: string[]; rank: number | null }[] {
  return (status.manifest?.provider?.backends ?? []).flatMap((raw) => {
    const parsed = DeclaredBackend.safeParse(raw);
    return parsed.success ? [{ id: parsed.data.id, names: parsed.data.binary?.names ?? [], rank: parsed.data.rank ?? null }] : [];
  });
}

type Group = {
  id: string;
  origin: ProviderOrigin;
  backendIds: string[];
  plugin: PluginStatus | null;
  pluginId: string | null;
  agent: AgentView | null;
  /** Program names per backend, when the manifest says so. */
  declaredNames: Map<string, string[]>;
  /** Display rank per backend, when the manifest says so. */
  declaredRanks: Map<string, number>;
  /** The only provider of its plugin: a program the plugin declares that no backend names is its own. */
  alone: boolean;
  /** A file of `~/.timon/backends/` that could not be loaded: what it is listed as, and why. */
  file?: { name: string; reason: string };
};

/** Everything the aggregation reads once per request. */
type Snapshot = {
  profiles: Map<string, BackendProfile>;
  overlays: Map<string, BackendOverlayRow>;
  catalog: Map<string, CatalogBackend>;
  /** Position in the model picker's order (the registry sorts the active backends by rank). */
  pickerOrder: Map<string, number>;
  reasons: Map<string, string>;
  pins: BinaryPinStatus[];
  cards: Map<string, SetupBackend>;
  defaultBackend: string | null;
  agentsByBackend: Map<string, number>;
  /** The subscription accounts the viewer may see, every backend at once. */
  accounts: ReturnType<typeof listBackendAccountsFor>;
  /** Files of `~/.timon/backends/` that could not be read, by id: the reason, which names keys, never values. */
  unreadable: Map<string, string>;
};

/** Agents per backend id, read once per overview: `listAgents` already resolves the implicit default. */
function agentsByBackend(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of listAgents()) {
    if (agent.backend) counts.set(agent.backend, (counts.get(agent.backend) ?? 0) + 1);
  }
  return counts;
}

function snapshot(viewer: DbViewer): Snapshot {
  const providerOf = new Map(providerClis().map((cli) => [cli.name, cli.provider]));
  const cards = new Map<string, SetupBackend>();
  for (const card of setupBackends(process.platform, undefined, (provider) => providerSignedIn(provider))) {
    const provider = providerOf.get(card.name);
    if (provider) cards.set(provider, card);
  }
  const catalog = backendCatalog().filter((entry) => !entry.account);
  return {
    profiles: new Map(installedProfiles().map((profile) => [profile.id, profile])),
    overlays: new Map(dbApi.listBackendOverlays().map((row) => [row.id, row])),
    catalog: new Map(catalog.map((entry) => [entry.id, entry])),
    pickerOrder: new Map(catalog.map((entry, index) => [entry.id, index])),
    reasons: new Map(inactiveProfiles().map((entry) => [entry.id, entry.reason])),
    pins: binaryPinStatuses(),
    cards,
    defaultBackend: tryDefaultBackendName(),
    agentsByBackend: agentsByBackend(),
    accounts: listBackendAccountsFor(viewer),
    unreadable: new Map(listLocalBackends().flatMap((entry) => (entry.profile === null && entry.issue ? [[entry.id, entry.issue] as const] : []))),
  };
}

function groups(sources: OverviewSources, snap: Snapshot): Group[] {
  const owners = registeredBackendOwners().profiles;
  const result: Group[] = [];
  const claimed = new Set<string>();
  const ownedBy = (owner: string): string[] => [...snap.profiles.keys()].filter((id) => owners[id] === owner);

  for (const status of sources.plugins) {
    const declared = status.manifest?.kind.includes('provider') ? declaredBackends(status) : [];
    const owned = ownedBy(status.id);
    if (declared.length === 0 && owned.length === 0 && !status.manifest?.kind.includes('provider')) continue;
    const ids = [...new Set([...declared.map((entry) => entry.id), ...owned])];
    const declaredNames = new Map(declared.map((entry) => [entry.id, entry.names]));
    const declaredRanks = new Map(declared.flatMap((entry) => (entry.rank === null ? [] : [[entry.id, entry.rank] as const])));
    const origin: ProviderOrigin = status.builtin ? 'built-in' : 'plugin';
    for (const id of ids) claimed.add(id);
    if (ids.length <= 1) {
      result.push({ id: status.id, origin, backendIds: ids, plugin: status, pluginId: status.id, agent: null, declaredNames, declaredRanks, alone: true });
      continue;
    }
    for (const backendId of ids) {
      result.push({
        id: `${status.id}.${backendId}`, origin, backendIds: [backendId], plugin: status, pluginId: status.id, agent: null, declaredNames, declaredRanks,
        alone: false,
      });
    }
  }

  for (const agent of sources.acpAgents) {
    if (!agent.installed) continue;
    const backendId = agent.installed.profileId ?? profileIdOf(agent.id);
    claimed.add(backendId);
    result.push({
      id: `catalog:${agent.id}`, origin: 'catalog', backendIds: [backendId], plugin: null, pluginId: null, agent, declaredNames: new Map(), declaredRanks: new Map(), alone: true,
    });
  }

  for (const [id] of snap.profiles) {
    if (claimed.has(id)) continue;
    const owner = owners[id];
    if (owner === ACP_REGISTRY_OWNER) continue;
    if (owner === LOCAL_FILE_OWNER) {
      result.push({ id: `user:${id}`, origin: 'user', backendIds: [id], plugin: null, pluginId: null, agent: null, declaredNames: new Map(), declaredRanks: new Map(), alone: true });
    } else if (owner) {
      // A registration whose plugin the loader does not list (a test, a plugin being swapped).
      result.push({ id: `${owner}.${id}`, origin: 'plugin', backendIds: [id], plugin: null, pluginId: owner, agent: null, declaredNames: new Map(), declaredRanks: new Map(), alone: true });
    } else {
      result.push({ id: `builtin:${id}`, origin: 'built-in', backendIds: [id], plugin: null, pluginId: null, agent: null, declaredNames: new Map(), declaredRanks: new Map(), alone: true });
    }
  }
  // A file nobody could read is still the person's provider: listed, so its reason is seen and fixed.
  for (const [id, reason] of snap.unreadable) {
    const free = LOCAL_BACKEND_ID_RE.test(id) && !claimed.has(id) && !snap.profiles.has(id);
    const base = { origin: 'user', plugin: null, pluginId: null, agent: null, declaredNames: new Map(), declaredRanks: new Map(), alone: true } as const;
    if (free) {
      result.push({ ...base, id: `user:${id}`, backendIds: [id], file: { name: id, reason } });
    } else {
      // No backend id: everything keyed by one (agents, accounts, the switch, the edit routes) is the owner's.
      result.push({ ...base, id: blockedFileProviderId(id), backendIds: [], file: { name: `${id}.json`, reason } });
    }
  }
  return result;
}

/** What follows `user:` stays inside the shape the page's route accepts (`provider-overview-routes.ts`). */
const FILE_PROVIDER_ID_RE = /^[A-Za-z0-9._@-]{1,190}$/;

/**
 * The provider id of a file that cannot stand as a backend. Its file name when
 * the route accepts it: a `.json` suffix no backend id carries keeps it apart
 * from `user:<id>`. Otherwise a readable slug and a hash of the name, stable
 * across reads so the page's link keeps working.
 */
function blockedFileProviderId(stem: string): string {
  const name = `${stem}.json`;
  if (FILE_PROVIDER_ID_RE.test(name)) return `user:${name}`;
  const slug = stem.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file';
  return `user:${slug}.${createHash('sha256').update(stem).digest('hex').slice(0, 8)}.json`;
}

/**
 * A file listed with no backend: its one row says why, and stands for nothing
 * of the backend whose id it took, so no action of its page reaches that one.
 */
function blockedFileOverview(group: Group, file: { name: string; reason: string }): ProviderOverview {
  return {
    id: group.id,
    name: file.name,
    brand: null,
    icon: null,
    origin: group.origin,
    pluginId: null,
    plugin: null,
    catalogAgent: null,
    enabled: true,
    isDefault: false,
    backends: [{
      id: file.name, label: file.name, active: false, disabled: false, reason: file.reason, modelCount: 0, defaultModel: null, isDefault: false, remote: false,
    }],
    modelCount: 0,
    agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [], host: null },
    secret: { required: false, present: false, names: [] },
    programs: [],
    status: 'blocked',
    updateAvailable: false,
  };
}

/** `fileReason`: why the file of this backend could not be loaded, when it is one. */
function backendView(id: string, snap: Snapshot, fileReason: string | null): ProviderBackendView {
  const profile = snap.profiles.get(id);
  const overlay = snap.overlays.get(id);
  const entry = snap.catalog.get(id);
  const dialect = profile ? getDialect(profile.dialect) : undefined;
  return {
    id,
    label: entry?.label ?? overlay?.label ?? profile?.label ?? id,
    active: entry !== undefined,
    disabled: !!(overlay?.disabled ?? profile?.disabled),
    reason: entry ? null : snap.reasons.get(id) ?? fileReason ?? (profile ? null : 'not registered'),
    modelCount: entry ? entry.models.length : (profile?.models.filter((model) => !model.hidden).length ?? 0),
    defaultModel: entry ? entry.defaultModel : profile?.defaultModel ?? null,
    isDefault: snap.defaultBackend === id,
    remote: entry?.remote === true || (dialect ? isRemoteDialect(dialect) : false),
  };
}

/** The name the model picker shows for a backend (`vendor`, else `label`, a rename winning). */
function pickerName(id: string, snap: Snapshot): string | null {
  const entry = snap.catalog.get(id);
  if (entry) return entry.vendor ?? entry.label;
  const profile = snap.profiles.get(id);
  if (!profile) return null;
  return snap.overlays.get(id)?.label ?? profile.vendor ?? profile.label;
}

function looksOf(id: string, snap: Snapshot): { brand: string | null; icon: string | null } {
  const entry = snap.catalog.get(id);
  if (entry) return { brand: entry.brand ?? null, icon: entry.icon ?? null };
  const profile = snap.profiles.get(id);
  const overlay = snap.overlays.get(id);
  return {
    brand: overlay?.brand === '' ? null : overlay?.brand ?? profile?.brand ?? null,
    icon: overlay?.icon === '' ? null : overlay?.icon ?? profile?.icon ?? null,
  };
}

/** The command a local backend launches; `null` for a remote one or an unknown dialect. */
function commandOf(profile: BackendProfile | undefined): string | null {
  if (!profile) return null;
  const dialect = getDialect(profile.dialect);
  if (!dialect || isRemoteDialect(dialect)) return null;
  return profile.cmd ?? dialect.defaultCmd;
}

function authorizationOf(requests: readonly ProviderBinaryRequest[]): { authorization: ProgramAuthorization | null; refusedReason: string | null } {
  if (requests.length === 0) return { authorization: null, refusedReason: null };
  const refused = requests.find((request) => request.refused);
  if (refused) return { authorization: 'refused', refusedReason: refused.refused };
  const found = requests.filter((request) => request.resolved);
  if (found.length === 0) return { authorization: 'install', refusedReason: null };
  return { authorization: found.every((request) => request.allowed) ? 'ready' : 'authorize', refusedReason: null };
}

function programs(group: Group, snap: Snapshot): ProviderProgramView[] {
  // Only a third party's program waits for the operator (`assertLaunchAuthorized`): a provider shipped in the
  // release is judged by the launch's own lists, and nothing asks to authorize it.
  const requests = group.plugin?.manifest && !group.plugin.builtin ? providerBinaryRequests(group.plugin.manifest) : [];
  const used = new Set<ProviderBinaryRequest>();
  const byName = new Map<string, ProviderProgramView>();
  const pins = config().host.binaries;

  for (const backendId of group.backendIds) {
    const profile = snap.profiles.get(backendId);
    const card = snap.cards.get(backendId);
    const cmd = commandOf(profile);
    const declared = group.declaredNames.get(backendId) ?? [...(profileDeclarations(backendId)?.binary?.names ?? [])];
    const names = [...new Set([...declared, ...(card ? [card.name] : []), ...(cmd ? [cmd] : [])])];
    if (names.length === 0) continue;
    const name = card?.name ?? declared[0] ?? cmd!;
    const pinStatus = snap.pins.find((status) => status.backends.includes(backendId) || names.includes(status.cmd));
    const matched = requests.filter((request) => names.includes(request.name));
    for (const request of matched) used.add(request);
    const known = byName.get(name);
    if (known) continue;
    byName.set(name, buildProgram(name, card, pinStatus, matched, cmd ?? name, pins));
  }

  // A program the plugin declares that no backend names: still the plugin's to authorize, on its
  // page when it is the plugin's only provider. Split into one provider per backend, each page
  // shows what its own backend launches — the only program a launch of it is checked against.
  if (group.alone) {
    for (const request of requests) {
      if (used.has(request) || byName.has(request.name)) continue;
      byName.set(request.name, buildProgram(request.name, undefined, undefined, [request], request.name, pins));
    }
  }
  return [...byName.values()];
}

function buildProgram(
  name: string,
  card: SetupBackend | undefined,
  pinStatus: BinaryPinStatus | undefined,
  requests: readonly ProviderBinaryRequest[],
  lookup: string,
  pins: Record<string, string | null>,
): ProviderProgramView {
  // What a spawn runs: the pin check resolves exactly like it, the card like the onboarding.
  const path = pinStatus?.path ?? card?.path ?? whichBin(lookup, pins).path;
  const canonical = requests.find((request) => request.resolved)?.resolved ?? (path ? canonicalPath(path) : null);
  const { authorization, refusedReason } = authorizationOf(requests);
  return {
    name,
    path,
    linkTarget: path && canonical && canonical !== path ? canonical : null,
    pinned: pinStatus?.pinned ?? false,
    pinKey: pinStatus?.cmd ?? null,
    pin: pinStatus?.pin ?? (typeof pins[lookup] === 'string' && pins[lookup] ? pins[lookup] : null),
    version: card?.version ?? null,
    latest: card?.latest ?? null,
    updateAvailable: card?.updateAvailable ?? false,
    unsupportedVersion: card?.unsupportedVersion ?? false,
    bundled: card?.bundled ?? false,
    installable: card?.installable ?? false,
    installCommand: card?.installCommand ?? null,
    installDocs: card?.installDocs ?? null,
    authorization,
    refusedReason,
  };
}

function secretOf(backendIds: readonly string[], snap: Snapshot): ProviderOverview['secret'] {
  const names = new Set<string>();
  let required = false;
  let present = true;
  for (const id of backendIds) {
    const profile = snap.profiles.get(id);
    if (!profile) continue;
    const own = secretNamesOf(profile);
    if (own.length === 0 && (profile.requiredEnv ?? []).length === 0) continue;
    required = true;
    for (const name of own) names.add(name);
    // The registry's own probe: an entry that exists but cannot reach this backend is not present.
    if (probeProfileEnv(profile) !== null) present = false;
  }
  return { required, present: required && present, names: [...names] };
}

/** `true` if any backend knows it is signed in, `false` if one knows it is not and none is, else unknown. */
function signedInOf(backendIds: readonly string[]): boolean | null {
  const verdicts = backendIds.map((id) => providerSignedIn(id));
  if (verdicts.includes(true)) return true;
  if (verdicts.includes(false)) return false;
  return null;
}

const UNRANKED = 10_000;

/**
 * The picker's order for what it lists; after it, what it does not (inactive, disabled, not
 * registered), by the rank a rename or the manifest gave. Ties go by name.
 */
function rankOf(group: Group, snap: Snapshot): [number, number] {
  const listed = group.backendIds.flatMap((id) => {
    const index = snap.pickerOrder.get(id);
    return index === undefined ? [] : [index];
  });
  if (listed.length > 0) return [0, Math.min(...listed)];
  const ranks = group.backendIds.map((id) =>
    snap.overlays.get(id)?.rank ?? snap.profiles.get(id)?.rank ?? group.declaredRanks.get(id) ?? UNRANKED);
  return [1, ranks.length ? Math.min(...ranks) : UNRANKED];
}

function overviewOf(group: Group, snap: Snapshot, viewer: DbViewer): ProviderOverview {
  if (group.file && group.backendIds.length === 0) return blockedFileOverview(group, group.file);
  const backends = group.backendIds.map((id) => backendView(id, snap, group.file?.reason ?? null));
  const first = group.backendIds[0];
  const card = group.backendIds.map((id) => snap.cards.get(id)).find((entry) => entry !== undefined);
  const looks = first ? looksOf(first, snap) : { brand: null, icon: null };
  const name = (first ? pickerName(first, snap) : null) ?? group.agent?.name ?? group.plugin?.manifest?.label
    ?? (group.origin === 'user' ? first : undefined) ?? group.id;
  const accounts = snap.accounts.filter((row) => group.backendIds.includes(row.backend)).map((row) => publicAccount(row, viewer));
  const secret = secretOf(group.backendIds, snap);
  const progs = programs(group, snap);
  const plugin = group.plugin;
  const installed = group.agent?.installed ?? null;
  // A provider that reads a key runs on nothing else: without it, a turn that once worked is no sign-in to show.
  const remembered = signedInOf(group.backendIds);
  const signedIn = secret.required && !secret.present && remembered === true ? null : remembered;
  const signInCommand = card?.signInCommand ?? (first ? snap.catalog.get(first)?.signInCommand : undefined) ?? null;
  const signInThen = card?.signInThen ?? (first ? snap.catalog.get(first)?.signInThen : undefined) ?? null;
  const disabled = plugin?.state === 'disabled' || (backends.length > 0 && backends.every((backend) => backend.disabled));
  const status = providerStatus({
    disabled,
    refused: progs.some((program) => program.authorization === 'refused') || installed?.state === 'tampered',
    programMissing: progs.some((program) => program.path === null && program.authorization !== 'refused') || installed?.state === 'missing',
    needsAuthorization: progs.some((program) => program.authorization === 'authorize'),
    failed: plugin?.state === 'failed' || plugin?.state === 'skipped' || group.file !== undefined
      || backends.some((backend) => !backend.active && !backend.disabled && backend.reason?.startsWith('dialect ') === true),
    signedIn,
    accountConnected: accounts.some((account) => account.connected && account.state !== 'reauth'),
    secretRequired: secret.required,
    secretPresent: secret.present,
    usable: backends.some((backend) => backend.active),
  });
  return {
    id: group.id,
    name,
    brand: looks.brand ?? card?.brand ?? null,
    icon: looks.icon,
    origin: group.origin,
    pluginId: group.pluginId,
    plugin: plugin ? {
      id: plugin.id,
      label: plugin.manifest?.label ?? plugin.id,
      version: plugin.version,
      state: plugin.state,
      reason: plugin.reason,
      signed: plugin.signed,
      builtin: plugin.builtin === true,
    } : null,
    catalogAgent: group.agent && installed ? {
      id: group.agent.id,
      version: installed.version,
      latest: group.agent.version,
      state: installed.state,
      integrity: installed.integrity,
      updateAvailable: installed.updateAvailable,
    } : null,
    enabled: !disabled,
    isDefault: backends.some((backend) => backend.isDefault),
    backends,
    modelCount: backends.reduce((sum, backend) => sum + backend.modelCount, 0),
    agentCount: group.backendIds.reduce((sum, id) => sum + (snap.agentsByBackend.get(id) ?? 0), 0),
    connection: {
      signedIn,
      signInCommand,
      signInThen,
      acceptsAccounts: group.backendIds.some((id) => backendTakesAccounts(id)),
      accounts,
      host: group.backendIds.map((id) => hostSignInView(id)).find((view) => view !== null) ?? null,
    },
    secret,
    programs: progs,
    status,
    updateAvailable: progs.some((program) => program.updateAvailable) || installed?.updateAvailable === true,
  };
}

/** Every provider, the default one first, then in the order of the backends' ranks. */
export function providersOverview(sources: OverviewSources): ProvidersOverview {
  const snap = snapshot(sources.viewer);
  const list = groups(sources, snap).map((group) => ({ group, rank: rankOf(group, snap) }));
  const providers = list
    .map(({ group, rank }) => ({ rank, view: overviewOf(group, snap, sources.viewer) }))
    .sort((a, b) => Number(b.view.isDefault) - Number(a.view.isDefault)
      || a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.view.name.localeCompare(b.view.name))
    .map(({ view }) => view);
  return { providers, defaultBackend: snap.defaultBackend };
}

/**
 * A provider as an account at the `accounts` level reads it
 * (`users/provider-access.ts`): enough for the list's status line and for the
 * Connection section with its OWN accounts. Nothing about this machine: no
 * program, no path, no vault name, no reason (a reason may name a path), and
 * not the sign-in of this computer's CLI, which is the operator's.
 */
export function narrowToOwnAccounts(provider: ProviderOverview): ProviderOverview {
  return {
    ...provider,
    plugin: provider.plugin ? { ...provider.plugin, reason: null } : null,
    backends: provider.backends.map((backend) => ({ ...backend, reason: null })),
    connection: {
      signedIn: null,
      signInCommand: null,
      signInThen: null,
      acceptsAccounts: provider.connection.acceptsAccounts,
      accounts: provider.connection.accounts.filter((account) => account.mine),
      host: null,
    },
    secret: { required: provider.secret.required, present: provider.secret.present, names: [] },
    programs: [],
  };
}
