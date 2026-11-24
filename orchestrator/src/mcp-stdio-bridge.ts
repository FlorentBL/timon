/**
 * The daemon's stdio ↔ streamable-HTTP bridge for an MCP server the user
 * declared with environment variables (TODO #1071, `docs/MCP-STDIO-BRIDGE.md`).
 *
 * Written into the CLI's configuration, a stdio server's `env` sat in a file of
 * the mission's scratch folder, readable by the shell the model drives; handed
 * to the CLI's own environment it would reach that shell all the same
 * (`SealedEnvError`, SECURITY.md § 6.4.1). So the daemon starts the server
 * itself, outside the mission's process tree, and the CLI reaches it over the
 * relay (`mcp-relay-server.ts`) like any credentialed http server: its
 * configuration holds a relay url and token, never a variable.
 *
 * One process per (mission, server). Started at launch, so a server that
 * cannot start is left out of the mission (fail-closed, never its variables in
 * clear); started again on demand when the relay finds none (a daemon restart,
 * a crash), at most `MAX_RESPAWNS` times a minute. Stopped with its mission,
 * with the daemon, and when a new CLI of the same mission initializes again.
 *
 * Its stderr is drained and dropped: a server may print its own environment.
 * The log names the server, the mission and an exit code, nothing else.
 */
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** What the bridge runs. `env` is the server's own, read from the vault by the caller. */
export type StdioBridgeSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
};

export type StdioBridgeDeps = {
  /** Starts the process with piped stdio. Must never throw: errors come through `error`. */
  spawn: (spec: StdioBridgeSpec) => ChildProcess;
  /** Ends the process and what it started. */
  stop: (child: ChildProcess) => void;
  /** Records the process for the sweep that follows a daemon that died outright. */
  track?: (child: ChildProcess, missionId: string) => void;
  now?: () => number;
  log?: (line: string) => void;
};

export const MAX_BRIDGES_PER_MISSION = 8;
export const MAX_BRIDGES = 48;
const MAX_RESPAWNS = 3;
const RESPAWN_WINDOW_MS = 60_000;
/** A line of stdout past this is no MCP message: the process is stopped. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** The protocol revision the bridge's own handshake asks for (a resumed CLI's server). */
const HANDSHAKE_PROTOCOL = '2025-06-18';

type JsonRpcId = string | number;
type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

/** `1` and `"1"` are two ids. */
function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isRequest(msg: JsonRpcMessage): boolean {
  return typeof msg.method === 'string' && isId(msg.id);
}

function isResponse(msg: JsonRpcMessage): boolean {
  return typeof msg.method !== 'string' && isId(msg.id) && ('result' in msg || 'error' in msg);
}

function errorResponse(id: JsonRpcId | null, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Where a server message goes: an open POST answered as a stream, or a GET stream. */
type Sink = { send: (msg: JsonRpcMessage) => void; streaming: boolean; end?: () => void };

type Exchange = {
  /** By id key, the ids still unanswered. */
  waiting: Map<string, JsonRpcId>;
  responses: JsonRpcMessage[];
  sink: Sink;
  done: () => void;
};

export type BridgeStart = { ok: true } | { ok: false; reason: string };

/** One running server: its process, its pending calls, its open streams. */
export class StdioBridge {
  private child: ChildProcess | null = null;
  private buffer = '';
  private bufferBytes = 0;
  /** The server has seen an `initialize` and its `initialized` (the CLI's, or the bridge's own). */
  private initialized = false;
  private handshake: Promise<boolean> | null = null;
  private readonly exchanges = new Set<Exchange>();
  private readonly byId = new Map<string, Exchange>();
  private readonly streams = new Set<Sink>();
  private readonly internal = new Map<string, (msg: JsonRpcMessage) => void>();
  private readonly spawns: number[] = [];
  private internalSeq = 0;
  private stopped = false;

  constructor(
    readonly missionId: string,
    readonly serverId: string,
    /** What the process runs: the route, held to tell a server whose command changed. */
    readonly fingerprint: string,
    private readonly spec: () => StdioBridgeSpec | null,
    private readonly deps: StdioBridgeDeps,
    private readonly onGone: (bridge: StdioBridge) => void,
  ) {}

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(`[timon] mcp bridge ${this.serverId} (mission ${this.missionId.slice(0, 8)}): ${line}`);
  }

  /** Starts the process when none runs; resolves once the OS said whether it started. */
  async start(): Promise<BridgeStart> {
    if (this.stopped) return { ok: false, reason: 'stopped' };
    if (this.alive) return { ok: true };
    const now = (this.deps.now ?? Date.now)();
    while (this.spawns.length && now - this.spawns[0]! > RESPAWN_WINDOW_MS) this.spawns.shift();
    // The first start does not count: a server that crashes in a loop does.
    if (this.spawns.length > MAX_RESPAWNS) return { ok: false, reason: 'restarted too often' };
    const spec = this.spec();
    if (!spec) return { ok: false, reason: 'its variables cannot be read from the secrets vault' };
    this.spawns.push(now);
    const child = this.deps.spawn(spec);
    this.child = child;
    this.initialized = false;
    this.handshake = null;
    this.buffer = '';
    this.bufferBytes = 0;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (this.child === child) this.onData(chunk); });
    // Drained and dropped: a server may print its own environment.
    child.stderr?.on('data', () => undefined);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => undefined);
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.stopped) this.log(`exited (${code ?? signal ?? 'unknown'})`);
      this.failPending('stopped');
    });
    const started = await new Promise<BridgeStart>((resolve) => {
      if (child.pid) { resolve({ ok: true }); return; }
      child.once('spawn', () => resolve({ ok: true }));
      child.once('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, reason: error.code ?? error.name }));
    });
    child.on('error', () => undefined);
    if (!started.ok) {
      if (this.child === child) this.child = null;
      return started;
    }
    this.deps.track?.(child, this.missionId);
    return started;
  }

  /** Ends the process for good: its mission is over, or its server is no longer attached. */
  stop(): void {
    this.stopped = true;
    this.kill();
    this.onGone(this);
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.failPending('stopped');
    if (child && child.exitCode === null && child.signalCode === null) {
      try { this.deps.stop(child); } catch { /* already gone */ }
    }
  }

  private failPending(why: string): void {
    for (const exchange of [...this.exchanges]) {
      for (const [key, id] of exchange.waiting) {
        this.byId.delete(key);
        exchange.responses.push(errorResponse(id, -32000, `MCP server ${this.serverId} ${why}`));
      }
      exchange.waiting.clear();
      this.finish(exchange);
    }
    for (const resolve of [...this.internal.values()]) resolve(errorResponse(null, -32000, why));
    this.internal.clear();
    // A GET stream belongs to the process: the client opens a new one if it wants.
    for (const sink of [...this.streams]) sink.end?.();
    this.streams.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk);
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
      nl = this.buffer.indexOf('\n');
    }
    this.bufferBytes = Buffer.byteLength(this.buffer);
    if (this.bufferBytes > MAX_LINE_BYTES) {
      this.log('stopped: a line of its output is larger than any MCP message');
      this.kill();
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; /* a stray log line, not a message */ }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of messages) {
      if (msg && typeof msg === 'object') this.route(msg as JsonRpcMessage);
    }
  }

  private route(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const key = idKey(msg.id as JsonRpcId);
      const own = this.internal.get(key);
      if (own) { this.internal.delete(key); own(msg); return; }
      const exchange = this.byId.get(key);
      if (exchange) {
        this.byId.delete(key);
        exchange.waiting.delete(key);
        if (exchange.sink.streaming) exchange.sink.send(msg);
        else exchange.responses.push(msg);
        if (exchange.waiting.size === 0) this.finish(exchange);
        return;
      }
    }
    // A notification or a request of the server's: the newest call answered as a stream, else a GET stream.
    const open = [...this.exchanges].reverse().find((e) => e.sink.streaming);
    if (open) { open.sink.send(msg); return; }
    const stream = [...this.streams].at(-1);
    if (stream) { stream.send(msg); return; }
    // Nobody to ask: a request left unanswered would hang the server's own call.
    if (isRequest(msg)) this.write(errorResponse(msg.id as JsonRpcId, -32601, 'no client stream open'));
  }

  private finish(exchange: Exchange): void {
    if (!this.exchanges.delete(exchange)) return;
    for (const key of exchange.waiting.keys()) this.byId.delete(key);
    exchange.done();
  }

  /** One line per message: a stdio server need not read a batch (the 2025-06-18 revision dropped them). */
  private write(...messages: JsonRpcMessage[]): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    for (const msg of messages) stdin.write(`${JSON.stringify(msg)}\n`);
    return true;
  }

  /** The bridge's own `initialize`, for a server whose CLI initialized a process that is gone. */
  private ensureInitialized(): Promise<boolean> {
    if (this.initialized) return Promise.resolve(true);
    this.handshake ??= (async () => {
      const id = `timon-bridge-init-${++this.internalSeq}`;
      const answer = new Promise<JsonRpcMessage | null>((resolve) => {
        const timer = setTimeout(() => { this.internal.delete(idKey(id)); resolve(null); }, HANDSHAKE_TIMEOUT_MS);
        timer.unref?.();
        this.internal.set(idKey(id), (msg) => { clearTimeout(timer); resolve(msg); });
      });
      const sent = this.write({
        jsonrpc: '2.0', id, method: 'initialize',
        params: { protocolVersion: HANDSHAKE_PROTOCOL, capabilities: {}, clientInfo: { name: 'timon-mcp-bridge', version: '1' } },
      });
      const msg = sent ? await answer : null;
      if (!msg || 'error' in msg) {
        this.handshake = null;
        return false;
      }
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.initialized = true;
      return true;
    })();
    return this.handshake;
  }

  /**
   * One POST of the CLI: a message or a batch. Answers 202 when it carries no
   * request; otherwise the responses, as a stream when the client takes one.
   */
  async post(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); } catch {
      json(res, 400, errorResponse(null, -32700, 'parse error'));
      return;
    }
    const batch = Array.isArray(parsed);
    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const messages = items.filter((m): m is JsonRpcMessage => !!m && typeof m === 'object' && !Array.isArray(m));
    if (!messages.length) {
      json(res, 400, errorResponse(null, -32600, 'invalid request'));
      return;
    }
    const initializing = messages.some((m) => m.method === 'initialize');
    // A new CLI on the same mission starts from a clean server, not one another client set up.
    if (initializing && this.alive && (this.initialized || this.handshake)) this.kill();
    if (!this.alive) {
      const started = await this.start();
      if (!started.ok) {
        unavailable(res, messages, batch, this.serverId);
        return;
      }
    }
    if (!initializing && !(await this.ensureInitialized())) {
      unavailable(res, messages, batch, this.serverId);
      return;
    }
    const requests = messages.filter(isRequest);
    if (!requests.length) {
      if (messages.some((m) => m.method === 'notifications/initialized')) this.initialized = true;
      this.write(...messages);
      res.writeHead(202).end();
      return;
    }
    const streaming = acceptsStream(req);
    const exchange: Exchange = {
      waiting: new Map(requests.map((m) => [idKey(m.id as JsonRpcId), m.id as JsonRpcId])),
      responses: [],
      sink: { streaming, send: () => undefined },
      done: () => undefined,
    };
    const finished = new Promise<void>((resolve) => { exchange.done = resolve; });
    if (streaming) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      exchange.sink.send = (msg) => { if (!res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); };
    }
    for (const key of exchange.waiting.keys()) this.byId.set(key, exchange);
    this.exchanges.add(exchange);
    res.on('close', () => this.finish(exchange));
    if (initializing) this.handshake = Promise.resolve(true);
    this.write(...messages);
    await finished;
    if (res.writableEnded || res.destroyed) return;
    if (streaming) {
      // Responses that a failure wrote after the stream had its own.
      for (const msg of exchange.responses) exchange.sink.send(msg);
      res.end();
      return;
    }
    json(res, 200, batch ? exchange.responses : exchange.responses[0] ?? errorResponse(null, -32603, 'no response'));
  }

  /** The optional GET stream: what the server says outside any call. */
  async openStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!acceptsStream(req)) {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (!this.alive && !(await this.start()).ok) {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sink: Sink = {
      streaming: true,
      send: (msg) => { if (!res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); },
      end: () => { if (!res.writableEnded) res.end(); },
    };
    this.streams.add(sink);
    res.on('close', () => this.streams.delete(sink));
  }
}

function acceptsStream(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/event-stream');
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** A server that cannot run: an error the model can read, never a 401 (which starts an OAuth flow). */
function unavailable(res: ServerResponse, messages: JsonRpcMessage[], batch: boolean, serverId: string): void {
  const requests = messages.filter(isRequest);
  if (!requests.length) { res.writeHead(202).end(); return; }
  const errors = requests.map((m) => errorResponse(m.id as JsonRpcId, -32001, `MCP server ${serverId} could not be started: check it on Timon's MCP servers page.`));
  json(res, 200, batch ? errors : errors[0]);
}

function bridgeKey(missionId: string, serverId: string): string {
  return `${missionId}\n${serverId}`;
}

/** Every bridge of this daemon, by (mission, server). */
export class StdioBridgeManager {
  private readonly bridges = new Map<string, StdioBridge>();

  constructor(private readonly deps: StdioBridgeDeps) {}

  get size(): number {
    return this.bridges.size;
  }

  get(missionId: string, serverId: string): StdioBridge | undefined {
    return this.bridges.get(bridgeKey(missionId, serverId));
  }

  /**
   * The bridge of a server for a mission, started. A bridge whose server's
   * command changed is stopped and replaced; the caps are checked before a
   * new one is made.
   */
  async ensure(
    missionId: string, serverId: string, fingerprint: string, spec: () => StdioBridgeSpec | null,
  ): Promise<{ bridge: StdioBridge } | { reason: string }> {
    const key = bridgeKey(missionId, serverId);
    let bridge = this.bridges.get(key);
    if (bridge && bridge.fingerprint !== fingerprint) {
      bridge.stop();
      bridge = undefined;
    }
    const fresh = !bridge;
    if (!bridge) {
      if (this.bridges.size >= MAX_BRIDGES) return { reason: `the daemon already runs ${MAX_BRIDGES} bridged MCP servers` };
      let ofMission = 0;
      for (const b of this.bridges.values()) if (b.missionId === missionId) ofMission += 1;
      if (ofMission >= MAX_BRIDGES_PER_MISSION) return { reason: `this mission already runs ${MAX_BRIDGES_PER_MISSION} bridged MCP servers` };
      bridge = new StdioBridge(missionId, serverId, fingerprint, spec, this.deps, (gone) => {
        if (this.bridges.get(key) === gone) this.bridges.delete(key);
      });
      this.bridges.set(key, bridge);
    }
    const started = await bridge.start();
    if (!started.ok) {
      // A bridge that ran before stays, its restart count with it: dropping it would reset the limit.
      if (fresh) bridge.stop();
      return { reason: started.reason };
    }
    return { bridge };
  }

  /** The mission is over: every server it ran stops. */
  stopMission(missionId: string): number {
    let stopped = 0;
    for (const bridge of [...this.bridges.values()]) {
      if (bridge.missionId !== missionId) continue;
      bridge.stop();
      stopped += 1;
    }
    return stopped;
  }

  stopAll(): void {
    for (const bridge of [...this.bridges.values()]) bridge.stop();
  }
}
