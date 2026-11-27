#!/usr/bin/env node
/** Computer-use MCP: drives the user's screen, mouse and keyboard through the daemon.
 * Identity comes from the mission token only; the daemon checks that the agent has
 * computer use turned on. Never reads the daemon token and never drives the machine itself. */
import readline from 'node:readline';

const origin = process.env.TIMON_ORCH_URL || 'http://127.0.0.1:3000';
const token = process.env.TIMON_API_TOKEN;
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const num = { type: 'number' };
const SEE_FIRST = ' Coordinates are in the pixels of the latest screenshot.';
// Every tool call is a model turn that re-reads the whole conversation: fewer calls and fewer images cost fewer tokens.
const THRIFT = ' To save tokens, chain the steps you can predict in one computer_actions call, and look at the screen only when the next step depends on it.';
const NO_PASSWORD = ' Never type a password, a one-time code or a payment detail: ask the user to do it.';
// The steps computer_actions accepts: the commands that act or wait, never one that reads.
const BATCH_ACTIONS = ['click', 'double_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait'];
const MAX_STEPS = 20;
const tools = [
  { name: 'computer_screenshot', description: `Capture the main screen as a JPEG, 1024 px wide by default. Ask for a larger maxWidth only to read small text, a smaller one (768) for a quick look.${THRIFT}`, inputSchema: schema({ maxWidth: { type: 'integer', minimum: 64, maximum: 4096 } }) },
  { name: 'computer_actions', description: `Run several steps in a row, then return one screenshot (unless screenshot is false). Each step is an object with an "action" (click, double_click, move, drag, type, key, scroll, wait) and that action's arguments, for example [{"action":"key","keys":"cmd+space"},{"action":"type","text":"TextEdit"},{"action":"key","keys":"Enter"},{"action":"wait","ms":1500}]. Stops at the first failing step and says which.${SEE_FIRST}${NO_PASSWORD}`, inputSchema: schema({
    steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { action: { type: 'string', enum: [...BATCH_ACTIONS] } }, required: ['action'] } },
    screenshot: { type: 'boolean' }, maxWidth: { type: 'integer', minimum: 64, maximum: 4096 },
  }, ['steps']) },
  { name: 'computer_click', description: `Click at a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, ['x', 'y']) },
  { name: 'computer_double_click', description: `Double-click at a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num }, ['x', 'y']) },
  { name: 'computer_move', description: `Move the mouse pointer to a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num }, ['x', 'y']) },
  { name: 'computer_drag', description: `Press at one point, drag, and release at another.${SEE_FIRST}`, inputSchema: schema({ fromX: num, fromY: num, toX: num, toY: num }, ['fromX', 'fromY', 'toX', 'toY']) },
  { name: 'computer_type', description: `Type text with the keyboard into the focused field (at most 2000 characters). Click the field first.${NO_PASSWORD}`, inputSchema: schema({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']) },
  { name: 'computer_key', description: `Press a key or a shortcut, such as "Enter", "cmd+c" or "ctrl+shift+t".${NO_PASSWORD}`, inputSchema: schema({ keys: { type: 'string', minLength: 1, maxLength: 100 } }, ['keys']) },
  { name: 'computer_scroll', description: `Scroll the wheel at a point of the screen; a positive deltaY scrolls down.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num, deltaX: num, deltaY: num }, ['x', 'y', 'deltaY']) },
  { name: 'computer_cursor_position', description: 'Read the current position of the mouse pointer, in screenshot coordinates.', inputSchema: schema() },
  { name: 'computer_wait', description: `Wait for the screen to settle, at most 10 seconds.${THRIFT}`, inputSchema: schema({ ms: { type: 'integer', minimum: 0, maximum: 10000 } }, ['ms']) },
];
// Tool name -> daemon command: the daemon is the one place that validates the arguments.
const COMMANDS = {
  computer_screenshot: 'screenshot', computer_click: 'click', computer_double_click: 'double_click', computer_move: 'move',
  computer_drag: 'drag', computer_type: 'type', computer_key: 'key', computer_scroll: 'scroll',
  computer_cursor_position: 'cursor_position', computer_wait: 'wait',
};
async function command(name, args) {
  if (!token) throw new Error('A mission token is required to control the computer.');
  const response = await fetch(`${origin}/api/computer/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args), signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error?.message || body.message || (typeof body.error === 'string' ? body.error : '') || `Computer request failed (${response.status}).`);
  return body.result;
}
/** Runs the steps one after the other through the daemon, which validates each of them as a single call would be. */
async function runActions(args) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (steps.length === 0 || steps.length > MAX_STEPS) throw new Error(`"steps" must hold 1 to ${MAX_STEPS} steps.`);
  let done = 0;
  for (const step of steps) {
    const { action, ...rest } = step && typeof step === 'object' ? step : {};
    if (!BATCH_ACTIONS.includes(action)) throw new Error(`Step ${done + 1}: unknown action ${JSON.stringify(action)}; ${done} step(s) done before it.`);
    try { await command(action, rest); } catch (error) {
      throw new Error(`Step ${done + 1} (${action}) failed: ${error.message}; ${done} step(s) done before it.`);
    }
    done += 1;
  }
  if (args.screenshot === false) return { steps: done };
  const shot = await command('screenshot', args.maxWidth === undefined ? {} : { maxWidth: args.maxWidth });
  return { ...shot, steps: done };
}
async function run(name, args) {
  if (name === 'computer_actions') return runActions(args);
  const mapped = COMMANDS[name];
  if (!mapped) throw new Error(`Unknown tool: ${name}`);
  return command(mapped, args);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  try {
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'timon-computer', version: '1.0.0' } };
    else if (msg.method === 'ping') result = {};
    else if (msg.method === 'tools/list') result = { tools };
    else if (msg.method === 'tools/call') {
      const value = await run(msg.params?.name, msg.params?.arguments ?? {});
      result = { content: typeof value?.data === 'string'
        ? [{ type: 'image', data: value.data, mimeType: value.mimeType || 'image/jpeg' },
          { type: 'text', text: JSON.stringify({ width: value.width, height: value.height, ...(value.steps === undefined ? {} : { steps: value.steps }) }) }]
        : [{ type: 'text', text: JSON.stringify(value) }] };
    } else return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
});
