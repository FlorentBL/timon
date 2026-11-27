#!/usr/bin/env node
/** Computer-use MCP: drives the user's screen, mouse and keyboard through the daemon.
 * Identity comes from the mission token only; the daemon checks that the agent has
 * computer use turned on. Never reads the daemon token and never drives the machine itself. */
import readline from 'node:readline';

const origin = process.env.TIMON_ORCH_URL || 'http://127.0.0.1:3000';
const token = process.env.TIMON_API_TOKEN;
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const num = { type: 'number' };
const SEE_FIRST = ' Coordinates are in the pixels of the latest computer_screenshot: take one before acting, and another to check the result.';
const NO_PASSWORD = ' Never type a password, a one-time code or a payment detail: ask the user to do it.';
const tools = [
  { name: 'computer_screenshot', description: 'Capture the main screen as an image. Take one before acting and after each action to check what happened.', inputSchema: schema({ maxWidth: { type: 'integer', minimum: 64, maximum: 4096 } }) },
  { name: 'computer_click', description: `Click at a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, ['x', 'y']) },
  { name: 'computer_double_click', description: `Double-click at a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num }, ['x', 'y']) },
  { name: 'computer_move', description: `Move the mouse pointer to a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num }, ['x', 'y']) },
  { name: 'computer_drag', description: `Press at one point, drag, and release at another.${SEE_FIRST}`, inputSchema: schema({ fromX: num, fromY: num, toX: num, toY: num }, ['fromX', 'fromY', 'toX', 'toY']) },
  { name: 'computer_type', description: `Type text with the keyboard into the focused field (at most 2000 characters). Click the field first.${NO_PASSWORD}`, inputSchema: schema({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']) },
  { name: 'computer_key', description: `Press a key or a shortcut, such as "Enter", "cmd+c" or "ctrl+shift+t".${NO_PASSWORD}`, inputSchema: schema({ keys: { type: 'string', minLength: 1, maxLength: 100 } }, ['keys']) },
  { name: 'computer_scroll', description: `Scroll the wheel at a point of the screen; a positive deltaY scrolls down.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num, deltaX: num, deltaY: num }, ['x', 'y', 'deltaY']) },
  { name: 'computer_cursor_position', description: 'Read the current position of the mouse pointer, in screenshot coordinates.', inputSchema: schema() },
  { name: 'computer_wait', description: 'Wait for the screen to settle, at most 10 seconds, then take a new screenshot.', inputSchema: schema({ ms: { type: 'integer', minimum: 0, maximum: 10000 } }, ['ms']) },
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
async function run(name, args) {
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
      result = { content: msg.params?.name === 'computer_screenshot' && typeof value?.data === 'string'
        ? [{ type: 'image', data: value.data, mimeType: value.mimeType || 'image/png' },
          { type: 'text', text: JSON.stringify({ width: value.width, height: value.height }) }]
        : [{ type: 'text', text: JSON.stringify(value) }] };
    } else return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
});
