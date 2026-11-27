import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { loadConfig } from '../../agent-config.js';
import { apiError } from '../../api-error.js';
import { dbApi } from '../../db.js';
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
  request_permissions: empty,
  restart_app: empty,
} as const;
type ComputerCommand = keyof typeof SCHEMAS;

const isCommand = (value: string): value is ComputerCommand => Object.hasOwn(SCHEMAS, value);
// A person's session may read the state and use the stop switch; nothing else.
const personCommands = new Set<ComputerCommand>(['status', 'stop', 'resume', 'request_permissions', 'restart_app']);
// The user's switch: an agent never stops or resumes itself.
// Setting up the machine (system prompts, restart) is the person's too.
const humanOnly = new Set<ComputerCommand>(['stop', 'resume', 'request_permissions', 'restart_app']);

export const COMPUTER_COMMANDS: readonly string[] = Object.freeze(Object.keys(SCHEMAS));

// The caller builds the error with a literal code: the catalogue test reads the codes from the call sites.
function refuse(error: ReturnType<typeof apiError>, status: number): never {
  throw new NativeComputerError(error, status);
}

/** Who the desktop sees behind a command: the daemon's reading of the authentication, never the caller's. */
function actorOf(req: Request, command: ComputerCommand): ComputerActor {
  if (isPersonAuth(req.auth)) {
    if (!personCommands.has(command)) refuse(apiError('computer_mission_token_required', 'A mission-bound token is required to control the computer.'), 403);
    return 'human';
  }
  if (req.auth?.kind !== 'api-token' || !req.auth.missionId) {
    refuse(apiError('computer_mission_token_required', 'A mission-bound token is required to control the computer.'), 403);
  }
  if (humanOnly.has(command)) refuse(apiError('computer_command_user_only', 'Stopping, resuming and setting up computer control is reserved for the user.'), 403);
  const mission = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
  let enabled = false;
  try { enabled = !!mission && loadConfig(mission.agent_name).computer_use === true; } catch { /* an unreadable config grants nothing */ }
  if (!enabled) refuse(apiError('computer_use_disabled', 'Computer use is turned off for this agent.'), 403);
  return 'agent';
}

/** The agent and mission behind an agent's command, for the journal; null for a person or an unbound token. */
function journalContext(req: Request): { agent: string; missionId: string } | null {
  if (req.auth?.kind !== 'api-token' || !req.auth.missionId) return null;
  const mission = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
  return mission ? { agent: mission.agent_name, missionId: req.auth.missionId } : null;
}

/** What the journal keeps of the arguments: coordinates and keys yes, typed text never (only its length). */
function journalArgs(command: ComputerCommand, body: unknown): Record<string, unknown> {
  const parsed = SCHEMAS[command].safeParse(body ?? {});
  if (!parsed.success) return { invalid: true };
  const args = parsed.data as Record<string, unknown>;
  if (command === 'type') return { length: (args.text as string).length };
  return args;
}

function record(ctx: { agent: string; missionId: string } | null, command: ComputerCommand, body: unknown, started: number, result: string): void {
  if (!ctx) return;
  // A failing journal never blocks the command it describes.
  try {
    dbApi.recordComputerJournal({ agent: ctx.agent, mission_id: ctx.missionId, command, args: journalArgs(command, body), result, duration_ms: Date.now() - started });
  } catch { /* nothing to do: the journal is best effort */ }
}

/** `call` is injected in HTTP tests; production never accepts a caller-selected endpoint. */
export function registerComputerRoutes(app: Router, deps: { call?: typeof callNativeComputer } = {}): void {
  const call = deps.call ?? callNativeComputer;
  // Read by people only (session or device): an agent's or a mission's token never reads its own journal.
  app.get('/api/computer/journal', (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (!isPersonAuth(req.auth)) {
      res.status(403).json(apiError('computer_journal_people_only', 'The computer-use journal is reserved to people.'));
      return;
    }
    const agent = typeof req.query.agent === 'string' ? req.query.agent : '';
    if (!agent || agent.length > 200) {
      res.status(400).json(apiError('computer_args_invalid', 'An agent name is required.'));
      return;
    }
    const limit = Number(req.query.limit ?? 50);
    res.json({ ok: true, entries: dbApi.listComputerJournal(agent, Number.isFinite(limit) ? limit : 50) });
  });
  app.post('/api/computer/:command', async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const started = Date.now();
    let ctx: ReturnType<typeof journalContext> = null;
    let known: ComputerCommand | null = null;
    let result = 'ok';
    try {
      const command = String(req.params.command);
      if (!isCommand(command)) refuse(apiError('computer_command_unknown', 'Unknown computer command.'), 400);
      known = command;
      ctx = journalContext(req);
      const actor = actorOf(req, command);
      // `actor` and every other key a caller adds are refused: the schema is strict, the body is only the arguments.
      const parsed = SCHEMAS[command].safeParse(req.body ?? {});
      if (!parsed.success) refuse(apiError('computer_args_invalid', 'Invalid arguments for this computer command.'), 400);
      const args = parsed.data as Record<string, unknown>;
      if (command === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, args.ms as number));
        res.json({ ok: true, result: { waited: args.ms } });
        return;
      }
      res.json({ ok: true, result: await call(command, args, actor) });
    } catch (error) {
      result = computerErrorBody(error).code;
      res.status(error instanceof NativeComputerError ? error.status : 400).json(computerErrorBody(error));
    } finally {
      if (known) record(ctx, known, req.body, started, result);
    }
  });
}
