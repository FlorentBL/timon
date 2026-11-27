import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { loadConfig } from '../../agent-config.js';
import { apiError } from '../../api-error.js';
import { scopedDb } from '../../users/scoped-db.js';
import { isPersonAuth, requireAuth, viewerFromRequest } from '../../users/identity.js';
import { callNativeComputer, computerErrorBody, NativeComputerError, type ComputerActor } from '../../native-computer-provider.js';

// Logical points of the screenshot's frame: bounded so a bad value never reaches the desktop's input driver.
const coord = z.number().finite().min(-100_000).max(100_000);
const empty = z.object({}).strict();
const point = z.object({ x: coord, y: coord }).strict();

/** The closed list of commands, each with the only arguments it accepts. */
const SCHEMAS = {
  status: empty,
  screenshot: z.object({ maxWidth: z.number().int().min(64).max(4096).optional() }).strict(),
  cursor_position: empty,
  move: point,
  click: z.object({ x: coord, y: coord, button: z.enum(['left', 'right', 'middle']).optional() }).strict(),
  double_click: point,
  drag: z.object({ fromX: coord, fromY: coord, toX: coord, toY: coord }).strict(),
  type: z.object({ text: z.string().min(1).max(2000) }).strict(),
  key: z.object({ keys: z.string().min(1).max(100) }).strict(),
  scroll: z.object({ x: coord, y: coord, deltaX: coord.optional(), deltaY: coord }).strict(),
  wait: z.object({ ms: z.number().int().min(0).max(10_000) }).strict(),
  stop: empty,
  resume: empty,
} as const;
type ComputerCommand = keyof typeof SCHEMAS;

const isCommand = (value: string): value is ComputerCommand => Object.hasOwn(SCHEMAS, value);
// A person's session may read the state and use the stop switch; nothing else.
const personCommands = new Set<ComputerCommand>(['status', 'stop', 'resume']);
// The user's switch: an agent never stops or resumes itself.
const humanOnly = new Set<ComputerCommand>(['stop', 'resume']);

export const COMPUTER_COMMANDS: readonly string[] = Object.freeze(Object.keys(SCHEMAS));

function refuse(code: string, message: string, status: number): never {
  throw new NativeComputerError(apiError(code, message), status);
}

/** Who the desktop sees behind a command: the daemon's reading of the authentication, never the caller's. */
function actorOf(req: Request, command: ComputerCommand): ComputerActor {
  if (isPersonAuth(req.auth)) {
    if (!personCommands.has(command)) refuse('computer_mission_token_required', 'A mission-bound token is required to control the computer.', 403);
    return 'human';
  }
  if (req.auth?.kind !== 'api-token' || !req.auth.missionId) {
    refuse('computer_mission_token_required', 'A mission-bound token is required to control the computer.', 403);
  }
  if (humanOnly.has(command)) refuse('computer_command_user_only', 'Stopping and resuming computer control is reserved for the user.', 403);
  const mission = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
  let enabled = false;
  try { enabled = !!mission && loadConfig(mission.agent_name).computer_use === true; } catch { /* an unreadable config grants nothing */ }
  if (!enabled) refuse('computer_use_disabled', 'Computer use is turned off for this agent.', 403);
  return 'agent';
}

/** `call` is injected in HTTP tests; production never accepts a caller-selected endpoint. */
export function registerComputerRoutes(app: Router, deps: { call?: typeof callNativeComputer } = {}): void {
  const call = deps.call ?? callNativeComputer;
  app.post('/api/computer/:command', async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const command = String(req.params.command);
      if (!isCommand(command)) refuse('computer_command_unknown', 'Unknown computer command.', 400);
      const actor = actorOf(req, command);
      // `actor` and every other key a caller adds are refused: the schema is strict, the body is only the arguments.
      const parsed = SCHEMAS[command].safeParse(req.body ?? {});
      if (!parsed.success) refuse('computer_args_invalid', 'Invalid arguments for this computer command.', 400);
      const args = parsed.data as Record<string, unknown>;
      if (command === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, args.ms as number));
        res.json({ ok: true, result: { waited: args.ms } });
        return;
      }
      res.json({ ok: true, result: await call(command, args, actor) });
    } catch (error) {
      res.status(error instanceof NativeComputerError ? error.status : 400).json(computerErrorBody(error));
    }
  });
}
