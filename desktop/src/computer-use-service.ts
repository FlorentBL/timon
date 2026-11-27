/**
 * The computer-native service: availability, stop/resume, coordinate conversion and dispatch.
 *
 * Every effect on the machine goes through an injected dependency (executor, capture, display),
 * so the whole decision logic runs under test with simulated ones. This file imports no Electron.
 */
import {
  ComputerCommandError, type ComputerActor, type ComputerCommand, type ComputerUnavailableReason,
} from './computer-use-protocol.js';
import { imageToPoints, pointsToImage, screenshotSize, type DisplayInfo, type ImageSize } from './computer-use-geometry.js';
import {
  MAC_TRUST_SCRIPT, buildInputCommand, macCommand, type InputAction, type InputPlatform, type SystemCommand,
} from './computer-use-input.js';

export interface ComputerUseDeps {
  platform: NodeJS.Platform;
  env: { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string; DISPLAY?: string };
  /** Runs one command without a shell and rejects when it fails. */
  exec: (command: SystemCommand) => Promise<{ stdout: string }>;
  /** The primary display, or null on a machine without one. */
  display: () => DisplayInfo | null;
  /** The pointer, in screen points. */
  cursor: () => { x: number; y: number };
  /** A PNG of the primary display at exactly this size, or null when the system gave an empty frame. */
  capture: (size: ImageSize) => Promise<Buffer | null>;
  /** macOS Screen Recording grant. `not-determined`: never asked yet, so asking shows the system prompt. */
  screenPermission: () => 'granted' | 'denied' | 'not-determined' | 'unknown';
  /**
   * Asks the system for the missing grant: the macOS prompt when it was never asked,
   * the matching Settings pane when the person already said no. Absent where nothing can be asked.
   */
  requestPermission?: (reason: 'permission-screen' | 'permission-accessibility') => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long an agent action keeps the indicator on. */
  activeMs?: number;
  onState?: (state: { active: boolean; stopped: boolean }) => void;
}

export interface ComputerStatus {
  platform: string;
  available: boolean;
  reason?: ComputerUnavailableReason;
  display: { width: number; height: number; scaleFactor: number };
  active: boolean;
  stopped: boolean;
}

const PROBE_TTL_MS = 3000;
/** One system prompt per missing grant and per minute: an agent retrying must not stack dialogs. */
const PERMISSION_ASK_INTERVAL_MS = 60_000;
const INPUT_TIMEOUT_NOTE = 'Input command failed.';

export class ComputerUseService {
  private stopped = false;
  private lastAgentAt = 0;
  private activeTimer: NodeJS.Timeout | null = null;
  private frame: ImageSize | null = null;
  private probe: { at: number; reason: ComputerUnavailableReason | null } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private reported = { active: false, stopped: false };
  private asked = new Map<string, number>();

  constructor(private readonly deps: ComputerUseDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private get activeMs(): number { return this.deps.activeMs ?? 8000; }
  get isStopped(): boolean { return this.stopped; }
  get isActive(): boolean { return !this.stopped && this.lastAgentAt > 0 && this.now() - this.lastAgentAt < this.activeMs; }

  /** Pushes the state to the indicator when it changed. */
  private publish(): void {
    const state = { active: this.isActive, stopped: this.stopped };
    if (state.active === this.reported.active && state.stopped === this.reported.stopped) return;
    this.reported = state;
    this.deps.onState?.(state);
  }

  private touch(): void {
    this.lastAgentAt = this.now();
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(() => { this.activeTimer = null; this.publish(); }, this.activeMs + 50);
    this.activeTimer.unref();
    this.publish();
  }

  /** Called by the global shortcut and the indicator's button: same effect as the `stop` command. */
  stop(): void {
    this.stopped = true;
    if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
    this.publish();
  }

  resume(): void {
    this.stopped = false;
    this.lastAgentAt = 0;
    this.publish();
  }

  dispose(): void {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = null;
  }

  private async unavailableReason(): Promise<ComputerUnavailableReason | null> {
    if (this.probe && this.now() - this.probe.at < PROBE_TTL_MS) return this.probe.reason;
    const reason = await this.probeReason();
    this.probe = { at: this.now(), reason };
    return reason;
  }

  private async probeReason(): Promise<ComputerUnavailableReason | null> {
    const { platform, env } = this.deps;
    if (this.deps.display() === null) return 'no-desktop';
    if (platform === 'darwin') {
      const screen = this.deps.screenPermission();
      if (screen === 'denied' || screen === 'not-determined') return 'permission-screen';
      try {
        const out = await this.deps.exec(macCommand(MAC_TRUST_SCRIPT));
        if (out.stdout.trim() !== 'true') return 'permission-accessibility';
      } catch { return 'no-input-tool'; }
      return null;
    }
    if (platform === 'win32') return null;
    if (platform === 'linux') {
      if (env.XDG_SESSION_TYPE === 'wayland') return 'wayland';
      if (!env.DISPLAY) return env.WAYLAND_DISPLAY ? 'wayland' : 'no-desktop';
      try { await this.deps.exec({ file: 'xdotool', args: ['version'] }); } catch { return 'no-input-tool'; }
      return null;
    }
    return 'no-desktop';
  }

  async status(): Promise<ComputerStatus> {
    const display = this.deps.display();
    const reason = await this.unavailableReason();
    return {
      platform: this.deps.platform,
      available: reason === null,
      ...(reason ? { reason } : {}),
      display: { width: display?.width ?? 0, height: display?.height ?? 0, scaleFactor: display?.scaleFactor ?? 1 },
      active: this.isActive,
      stopped: this.stopped,
    };
  }

  /** One command at a time: two inputs interleaved would be worse than a short wait. */
  handle(actor: ComputerActor, command: ComputerCommand): Promise<unknown> {
    const run = this.queue.then(() => this.dispatch(actor, command));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatch(actor: ComputerActor, command: ComputerCommand): Promise<unknown> {
    if (command.command === 'status') return this.status();
    if (command.command === 'stop' || command.command === 'resume') {
      if (actor !== 'human') throw new ComputerCommandError('Only a person can stop or resume computer use.', 403, 'forbidden');
      if (command.command === 'stop') this.stop(); else this.resume();
      return { stopped: this.stopped };
    }
    if (actor === 'agent' && this.stopped) {
      throw new ComputerCommandError('Computer use was stopped by the user.', 409, 'computer_stopped');
    }
    const reason = await this.unavailableReason();
    if (reason) {
      if (reason === 'permission-screen' || reason === 'permission-accessibility') await this.askPermission(reason);
      throw new ComputerCommandError(`Computer use is unavailable: ${reason}.`, 503, 'computer_unavailable');
    }
    const display = this.deps.display();
    if (!display) throw new ComputerCommandError('Computer use is unavailable: no-desktop.', 503, 'computer_unavailable');
    if (actor === 'agent') this.touch();
    switch (command.command) {
      case 'screenshot': return this.screenshot(display, command.maxWidth);
      case 'cursor_position': {
        const point = this.deps.cursor();
        return pointsToImage(display, this.currentFrame(display), point.x, point.y);
      }
      case 'wait':
        await (this.deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(command.ms);
        return {};
      default: return this.input(display, command);
    }
  }

  /**
   * The first refused action is what shows the person the system prompt: without it, a grant
   * that was never asked for stays missing and nothing tells them where to give it.
   */
  private async askPermission(reason: 'permission-screen' | 'permission-accessibility'): Promise<void> {
    const request = this.deps.requestPermission;
    if (!request) return;
    const last = this.asked.get(reason);
    if (last !== undefined && this.now() - last < PERMISSION_ASK_INTERVAL_MS) return;
    this.asked.set(reason, this.now());
    // The grant changes outside the app: probe again at the next command rather than in 3 s.
    this.probe = null;
    try { await request(reason); } catch { /* A failed prompt leaves the refusal as it is. */ }
  }

  private currentFrame(display: DisplayInfo): ImageSize {
    return this.frame ?? screenshotSize(display, 1280);
  }

  private async screenshot(display: DisplayInfo, maxWidth: number): Promise<unknown> {
    const size = screenshotSize(display, maxWidth);
    const png = await this.deps.capture(size);
    if (!png || png.length === 0) throw new ComputerCommandError('Computer use is unavailable: permission-screen.', 503, 'computer_unavailable');
    // Later coordinates are expressed in this image.
    this.frame = size;
    return { mimeType: 'image/png', data: png.toString('base64'), width: size.width, height: size.height };
  }

  private async input(display: DisplayInfo, command: ComputerCommand): Promise<unknown> {
    const frame = this.currentFrame(display);
    const point = (x: number, y: number) => imageToPoints(display, frame, x, y);
    let action: InputAction;
    switch (command.command) {
      case 'move': action = { kind: 'move', ...point(command.x, command.y) }; break;
      case 'click': action = { kind: 'click', ...point(command.x, command.y), button: command.button, count: 1 }; break;
      case 'double_click': action = { kind: 'click', ...point(command.x, command.y), button: 'left', count: 2 }; break;
      case 'drag': {
        const from = point(command.fromX, command.fromY);
        const to = point(command.toX, command.toY);
        action = { kind: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
        break;
      }
      case 'type': action = { kind: 'type', text: command.text }; break;
      case 'key': action = { kind: 'key', keys: command.keys }; break;
      case 'scroll': action = { kind: 'scroll', ...point(command.x, command.y), deltaX: command.deltaX, deltaY: command.deltaY }; break;
      default: throw new ComputerCommandError('Unknown computer command.', 404, 'unknown_command');
    }
    const system = buildInputCommand(this.deps.platform as InputPlatform, action, display);
    try {
      await this.deps.exec(system);
    } catch {
      // Never echo the error: for `type` it could carry the text.
      throw new ComputerCommandError(INPUT_TIMEOUT_NOTE, 502, 'input_failed');
    }
    return {};
  }
}
