/** Commands of the computer-native service: validation of what the daemon sends, and the shared error type. */

export const COMPUTER_MAX_TEXT = 2000;
export const COMPUTER_MAX_WAIT_MS = 10_000;
export const COMPUTER_DEFAULT_MAX_WIDTH = 1280;

export type ComputerActor = 'agent' | 'human';
export type ComputerUnavailableReason =
  'wayland' | 'no-input-tool' | 'permission-accessibility' | 'permission-screen' | 'no-desktop';
export type MouseButton = 'left' | 'right' | 'middle';

export class ComputerCommandError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'invalid_command') {
    super(message);
  }
}

export type ComputerCommand =
  | { command: 'status' }
  | { command: 'screenshot'; maxWidth: number }
  | { command: 'cursor_position' }
  | { command: 'move'; x: number; y: number }
  | { command: 'click'; x: number; y: number; button: MouseButton }
  | { command: 'double_click'; x: number; y: number }
  | { command: 'drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { command: 'type'; text: string }
  | { command: 'key'; keys: string }
  | { command: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { command: 'wait'; ms: number }
  | { command: 'stop' }
  | { command: 'resume' };

const NAMES = new Set(['status', 'screenshot', 'cursor_position', 'move', 'click', 'double_click', 'drag',
  'type', 'key', 'scroll', 'wait', 'stop', 'resume']);

function coordinate(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  // Bounded: a coordinate far outside any screen is a bug upstream, never an intent.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -100_000 || value > 100_000) {
    throw new ComputerCommandError(`"${name}" must be a finite number.`);
  }
  return value;
}

function optionalDelta(args: Record<string, unknown>, name: string): number {
  if (args[name] === undefined) return 0;
  const value = coordinate(args, name);
  return Math.max(-10_000, Math.min(10_000, value));
}

export function parseComputerActor(value: unknown): ComputerActor {
  if (value === 'agent' || value === 'human') return value;
  throw new ComputerCommandError('"actor" must be "agent" or "human".');
}

export function parseComputerCommand(name: unknown, rawArgs: unknown): ComputerCommand {
  if (typeof name !== 'string' || !NAMES.has(name)) throw new ComputerCommandError('Unknown computer command.', 404, 'unknown_command');
  if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
    throw new ComputerCommandError('"args" must be an object.');
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'screenshot': {
      if (args.maxWidth === undefined) return { command: 'screenshot', maxWidth: COMPUTER_DEFAULT_MAX_WIDTH };
      const maxWidth = coordinate(args, 'maxWidth');
      if (!Number.isInteger(maxWidth) || maxWidth < 64 || maxWidth > 8192) throw new ComputerCommandError('"maxWidth" must be an integer between 64 and 8192.');
      return { command: 'screenshot', maxWidth };
    }
    case 'move': return { command: 'move', x: coordinate(args, 'x'), y: coordinate(args, 'y') };
    case 'click': {
      const button = args.button ?? 'left';
      if (button !== 'left' && button !== 'right' && button !== 'middle') throw new ComputerCommandError('"button" must be left, right or middle.');
      return { command: 'click', x: coordinate(args, 'x'), y: coordinate(args, 'y'), button };
    }
    case 'double_click': return { command: 'double_click', x: coordinate(args, 'x'), y: coordinate(args, 'y') };
    case 'drag':
      return { command: 'drag', fromX: coordinate(args, 'fromX'), fromY: coordinate(args, 'fromY'), toX: coordinate(args, 'toX'), toY: coordinate(args, 'toY') };
    case 'type': {
      if (typeof args.text !== 'string' || args.text.length === 0 || args.text.length > COMPUTER_MAX_TEXT) {
        throw new ComputerCommandError(`"text" must be a string of 1 to ${COMPUTER_MAX_TEXT} characters.`);
      }
      return { command: 'type', text: args.text };
    }
    case 'key': {
      if (typeof args.keys !== 'string' || args.keys.length === 0 || args.keys.length > 100) throw new ComputerCommandError('"keys" must be a short string such as "cmd+c".');
      return { command: 'key', keys: args.keys };
    }
    case 'scroll':
      return { command: 'scroll', x: coordinate(args, 'x'), y: coordinate(args, 'y'), deltaX: optionalDelta(args, 'deltaX'), deltaY: optionalDelta(args, 'deltaY') };
    case 'wait': {
      const ms = coordinate(args, 'ms');
      if (ms < 0 || ms > COMPUTER_MAX_WAIT_MS) throw new ComputerCommandError(`"ms" must be between 0 and ${COMPUTER_MAX_WAIT_MS}.`);
      return { command: 'wait', ms };
    }
    default: return { command: name } as ComputerCommand;
  }
}
