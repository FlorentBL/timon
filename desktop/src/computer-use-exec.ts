/** The real executor of the computer-native service: no shell, a timeout, bounded output. */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { SystemCommand } from './computer-use-input.js';

export function runSystemCommand(command: SystemCommand, timeoutMs = 20_000): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, {
      timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, ...command.env },
    }, (error, stdout) => {
      if (error) reject(error); else resolve({ stdout: String(stdout) });
    });
  });
}

const WORKER_READY_MS = 20_000;
const WORKER_IDLE_MS = 120_000;

/** A child that answers one stdout line per stdin line. Never given a shell. */
class LineWorker {
  private readonly child: ChildProcess;
  private pending = '';
  private readonly lines: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private closed = false;
  private idle: NodeJS.Timeout | null = null;

  constructor(file: string, args: string[], env: Record<string, string> | undefined, private readonly onClose: () => void) {
    this.child = spawn(file, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.pending += chunk;
      let newline = this.pending.indexOf('\n');
      while (newline >= 0) {
        this.deliver(this.pending.slice(0, newline).replace(/\r$/, ''));
        this.pending = this.pending.slice(newline + 1);
        newline = this.pending.indexOf('\n');
      }
    });
    const end = (): void => {
      if (this.closed) return;
      this.closed = true;
      this.waiter?.(null);
      this.waiter = null;
      this.onClose();
    };
    this.child.once('error', end);
    this.child.once('close', end);
    this.child.stdin?.on('error', () => { /* The close event reports it. */ });
    this.child.unref();
  }

  get alive(): boolean { return !this.closed; }

  private deliver(line: string): void {
    if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter(line); } else this.lines.push(line);
  }

  /** The next line, or null when the child ended or `timeoutMs` passed. */
  private next(timeoutMs: number): Promise<string | null> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiter = null; resolve(null); }, timeoutMs);
      this.waiter = (line) => { clearTimeout(timer); resolve(line); };
    });
  }

  async ready(): Promise<boolean> { return (await this.next(WORKER_READY_MS)) === 'ready'; }

  /** One request, one answer. A null answer means the worker is no longer trustworthy: it is killed. */
  async request(input: string, timeoutMs: number): Promise<string | null> {
    if (this.idle) clearTimeout(this.idle);
    this.child.stdin?.write(`${input}\n`);
    const answer = await this.next(timeoutMs);
    if (answer === null) this.kill();
    else {
      this.idle = setTimeout(() => this.kill(), WORKER_IDLE_MS);
      this.idle.unref();
    }
    return answer;
  }

  kill(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.child.kill();
  }
}

export interface SystemExecutor {
  run: (command: SystemCommand) => Promise<{ stdout: string }>;
  /** Stops the persistent processes. */
  dispose: () => void;
}

/**
 * Runs system commands; those that carry a `worker` go to one long-lived process per worker
 * definition, started on first use. A worker that cannot start (or never says ready) is given up
 * for good and the same command then runs as a one-shot, which does the same thing, slower.
 */
export function createSystemExecutor(): SystemExecutor {
  const workers = new Map<string, LineWorker>();
  const broken = new Set<string>();

  async function workerFor(command: SystemCommand & { worker: NonNullable<SystemCommand['worker']> }): Promise<LineWorker | null> {
    const key = [command.file, ...command.worker.args].join('\0');
    if (broken.has(key)) return null;
    const existing = workers.get(key);
    if (existing?.alive) return existing;
    const worker = new LineWorker(command.file, command.worker.args, undefined, () => { if (workers.get(key) === worker) workers.delete(key); });
    workers.set(key, worker);
    if (await worker.ready()) return worker;
    worker.kill();
    workers.delete(key);
    broken.add(key);
    return null;
  }

  return {
    async run(command) {
      if (!command.worker) return runSystemCommand(command);
      const worker = await workerFor({ ...command, worker: command.worker });
      if (!worker) return runSystemCommand(command);
      const answer = await worker.request(command.worker.input, 20_000);
      // Not retried as a one-shot: the input may already have been performed.
      if (answer !== 'ok') throw new Error('Input worker failed.');
      return { stdout: '' };
    },
    dispose() {
      for (const worker of workers.values()) worker.kill();
      workers.clear();
    },
  };
}
