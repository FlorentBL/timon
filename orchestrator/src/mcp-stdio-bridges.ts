/**
 * The daemon's bridges of stdio MCP servers (`mcp-stdio-bridge.ts`), wired to
 * the host: how a process is started and ended on each system, where it runs,
 * what environment it gets, and when its mission ends.
 */
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { canonicalAgentName, loadConfig } from './agent-config.js';
import { bus, type BusEvent } from './bus.js';
import { dbApi } from './db.js';
import { getHost } from './host/index.js';
import { stopProcessGroup } from './host/kill-tree.js';
import { withLaunchPath } from './host/launch-path.js';
import { missionProcessDir, trackMissionProcess } from './host/mission-processes.js';
import { mcpRelayRoute } from './mcp-relay-route.js';
import { mcpStdioBridgeLaunch } from './mcp.js';
import { StdioBridgeManager, type StdioBridge, type StdioBridgeSpec } from './mcp-stdio-bridge.js';
import { createNotification } from './notifications.js';
import { TIMON_HOME } from './paths.js';
import { systemEnv } from './secrets/env.js';

/**
 * The environment a bridged server starts with: the system's allowlisted
 * variables, a PATH that finds `node` and npm's tools like a mission's does,
 * then the server's own variables. Never the daemon's environment (its token),
 * never a mission's vault slice.
 */
export function bridgeEnvironment(serverEnv: Record<string, string>): NodeJS.ProcessEnv {
  const host = getHost();
  const base = withLaunchPath(systemEnv(process.env), {
    platform: host.platform,
    findNode: () => { try { return host.bin('node'); } catch { return null; } },
    selfExecutable: process.versions.electron ? process.execPath : undefined,
  });
  return { ...base, ...serverEnv };
}

function spawnBridge(spec: StdioBridgeSpec): ChildProcess {
  const host = getHost();
  return host.spawn(spec.command, spec.args, {
    cwd: spec.cwd ?? homedir(),
    env: bridgeEnvironment(spec.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own group on POSIX, so that ending it ends what `npx` started under it.
    detached: host.platform !== 'win32',
    windowsHide: true,
  });
}

export const stdioBridges = new StdioBridgeManager({
  spawn: spawnBridge,
  stop: (child) => stopProcessGroup(child, 'SIGTERM'),
  // On disk like a mission's CLI: a daemon killed outright leaves no server running for good.
  track: (child, missionId) => trackMissionProcess(child, missionId, { dir: missionProcessDir(TIMON_HOME), host: getHost() }),
});

/** Where a mission's bridge runs: the mission's folder, as the CLI that used to start it. */
function missionCwd(missionId: string, agent: string): string | null {
  const mission = dbApi.getMission(missionId);
  if (mission?.cwd_override) return mission.cwd_override;
  try { return loadConfig(canonicalAgentName(agent)).cwd ?? null; } catch { return null; }
}

function specFor(id: string, cwd: string | null): () => StdioBridgeSpec | null {
  return () => {
    const launch = mcpStdioBridgeLaunch(id);
    return launch ? { command: launch.command, args: launch.args, env: launch.env, cwd } : null;
  };
}

// One notice per server and mission: a resumed mission launches again and again.
const noticed = new Set<string>();

function noticeLeftOut(missionId: string, serverId: string, reason: string): void {
  console.warn(`[timon] mcp ${serverId} left out of mission ${missionId.slice(0, 8)}: its bridge did not start (${reason})`);
  const key = `${missionId}\n${serverId}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  createNotification({
    type: 'alert',
    title: `MCP server ${serverId} left out`,
    body: `Timon could not start the MCP server ${serverId} for this mission (${reason}), so the agent runs without it. Its variables were not handed to the agent.`,
    missionId,
  });
}

/**
 * Starts the bridge of a stdio server for a mission being launched. `false`
 * when it did not start (fail-closed: the launch leaves the server out).
 */
export async function startStdioBridge(
  missionId: string, agent: string, server: { id: string; target: string }, cwd: string | null,
): Promise<boolean> {
  const fingerprint = mcpRelayRoute(server.id, server.target);
  const result = await stdioBridges.ensure(missionId, server.id, fingerprint, specFor(server.id, cwd ?? missionCwd(missionId, agent)));
  if ('reason' in result) {
    noticeLeftOut(missionId, server.id, result.reason);
    return false;
  }
  return true;
}

/** The running bridge the relay hands a request to, started again when none runs. */
export async function stdioBridgeFor(missionId: string, agent: string, serverId: string): Promise<StdioBridge | null> {
  const launch = mcpStdioBridgeLaunch(serverId);
  if (!launch) return null;
  const fingerprint = mcpRelayRoute(serverId, launch.target);
  const existing = stdioBridges.get(missionId, serverId);
  if (existing && existing.fingerprint === fingerprint) return existing;
  const result = await stdioBridges.ensure(missionId, serverId, fingerprint, specFor(serverId, missionCwd(missionId, agent)));
  if ('reason' in result) {
    console.warn(`[timon] mcp ${serverId}: bridge for mission ${missionId.slice(0, 8)} did not start (${result.reason})`);
    return null;
  }
  return result.bridge;
}

/** Ends a mission's servers with it, and every server with the daemon. Registered once, at boot. */
export function startStdioBridgeLifecycle(): () => void {
  const onEvent = (ev: BusEvent): void => {
    if (ev.kind !== 'mission_complete') return;
    stdioBridges.stopMission(ev.missionId);
    for (const key of [...noticed]) if (key.startsWith(`${ev.missionId}\n`)) noticed.delete(key);
  };
  const onExit = (): void => stdioBridges.stopAll();
  bus.on('event', onEvent);
  process.once('exit', onExit);
  return () => {
    bus.off('event', onEvent);
    process.off('exit', onExit);
    stdioBridges.stopAll();
  };
}
