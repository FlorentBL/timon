import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerCommandError, parseComputerCommand } from './computer-use-protocol.js';
import { ComputerUseService, type ComputerUseDeps } from './computer-use-service.js';
import type { SystemCommand } from './computer-use-input.js';

const display = { width: 1440, height: 900, scaleFactor: 2 };

function setup(overrides: Partial<ComputerUseDeps> = {}) {
  const calls: SystemCommand[] = [];
  const states: Array<{ active: boolean; stopped: boolean }> = [];
  const service = new ComputerUseService({
    platform: 'darwin', env: {},
    exec: async (command) => { calls.push(command); return { stdout: 'true\n' }; },
    display: () => display,
    cursor: () => ({ x: 720, y: 450 }),
    capture: async () => Buffer.from('png-bytes'),
    screenPermission: () => 'granted',
    sleep: async () => {},
    activeMs: 30,
    onState: (state) => states.push(state),
    ...overrides,
  });
  const run = (command: string, args?: unknown, actor: 'agent' | 'human' = 'agent') => service.handle(actor, parseComputerCommand(command, args));
  return { service, calls, states, run };
}

test('screenshot sets the frame later coordinates are expressed in', async () => {
  const { run, calls } = setup();
  const shot = await run('screenshot', { maxWidth: 720 }) as { data: string; width: number; height: number; mimeType: string };
  assert.deepEqual([shot.mimeType, shot.width, shot.height], ['image/png', 720, 450]);
  assert.equal(Buffer.from(shot.data, 'base64').toString(), 'png-bytes');
  calls.length = 0;
  await run('click', { x: 360, y: 225 });
  const steps = JSON.parse(calls[0]!.args[4]!);
  assert.deepEqual(steps[0], { t: 'move', x: 720, y: 450 });
  assert.deepEqual(await run('cursor_position'), { x: 360, y: 225 });
});

test('status reports platform, display, availability and activity', async () => {
  const { run } = setup();
  assert.deepEqual(await run('status'), { platform: 'darwin', available: true, display, active: false, stopped: false });
  await run('move', { x: 1, y: 1 });
  assert.equal(((await run('status')) as { active: boolean }).active, true);
});

test('stop refuses agent commands with computer_stopped until a person resumes', async () => {
  const { run, service, calls } = setup();
  await run('move', { x: 1, y: 1 });
  await run('stop', undefined, 'human');
  assert.equal(service.isStopped, true);
  await assert.rejects(run('click', { x: 1, y: 1 }), (e: ComputerCommandError) => e.code === 'computer_stopped' && e.statusCode === 409);
  const before = calls.length;
  assert.equal(calls.length, before, 'a refused command runs nothing');
  assert.equal(((await run('status')) as { stopped: boolean }).stopped, true); // status stays readable and reports it
  await assert.rejects(run('resume'), (e: ComputerCommandError) => e.statusCode === 403);
  await assert.rejects(run('stop'), (e: ComputerCommandError) => e.statusCode === 403);
  await run('resume', undefined, 'human');
  await run('move', { x: 2, y: 2 });
});

test('the global shortcut path (service.stop) behaves like the stop command and updates the indicator', async () => {
  const { run, service, states } = setup();
  await run('move', { x: 1, y: 1 });
  service.stop();
  assert.deepEqual(states.at(-1), { active: false, stopped: true });
  await assert.rejects(run('type', { text: 'x' }), /stopped/);
});

test('indicator goes off after the idle delay', async () => {
  const { run, states } = setup();
  await run('move', { x: 1, y: 1 });
  assert.equal(states.at(-1)?.active, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(states.at(-1)?.active, false);
});

test('macOS permissions are reported as reasons and refuse commands', async () => {
  const noAccessibility = setup({ exec: async () => ({ stdout: 'false\n' }) });
  assert.deepEqual(await noAccessibility.run('status'), { platform: 'darwin', available: false, reason: 'permission-accessibility', display, active: false, stopped: false });
  await assert.rejects(noAccessibility.run('click', { x: 1, y: 1 }), (e: ComputerCommandError) => e.code === 'computer_unavailable' && /permission-accessibility/.test(e.message));
  const noScreen = setup({ screenPermission: () => 'denied' });
  assert.equal(((await noScreen.run('status')) as { reason: string }).reason, 'permission-screen');
  const emptyFrame = setup({ capture: async () => null });
  await assert.rejects(emptyFrame.run('screenshot'), /permission-screen/);
});

test('Linux: wayland, missing tool and missing desktop are refused with a reason', async () => {
  const reason = async (deps: Partial<ComputerUseDeps>) => ((await setup({ platform: 'linux', ...deps }).run('status')) as { available: boolean; reason?: string });
  assert.equal((await reason({ env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } })).reason, 'wayland');
  assert.equal((await reason({ env: { XDG_SESSION_TYPE: 'wayland' } })).reason, 'wayland');
  // XWayland with the session type lost by the launcher is still Wayland; an explicit X11 session is not.
  assert.equal((await reason({ env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } })).reason, 'wayland');
  assert.equal((await reason({ env: { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } })).available, true);
  assert.equal((await reason({ env: { DISPLAY: ':0' }, exec: async () => { throw new Error('ENOENT'); } })).reason, 'no-input-tool');
  assert.equal((await reason({ env: {} })).reason, 'no-desktop');
  assert.equal((await reason({ env: { DISPLAY: ':0' } })).available, true);
  assert.equal((await reason({ env: { DISPLAY: ':0' }, display: () => null })).reason, 'no-desktop');
});

test('a failing input command hides its details (the typed text could be in them)', async () => {
  const { run } = setup({ exec: async (command) => { if (command.args.length > 4) throw new Error('secret-text'); return { stdout: 'true' }; } });
  await assert.rejects(run('type', { text: 'secret-text' }), (e: ComputerCommandError) => e.code === 'input_failed' && !/secret/.test(e.message));
});

test('arguments are validated', () => {
  assert.throws(() => parseComputerCommand('type', { text: 'x'.repeat(2001) }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('type', { text: '' }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('wait', { ms: 10001 }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('click', { x: 'a', y: 1 }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('click', { x: 1, y: 1, button: 'back' }), ComputerCommandError);
  assert.throws(() => parseComputerCommand('rm', {}), /Unknown/);
  assert.deepEqual(parseComputerCommand('screenshot', {}), { command: 'screenshot', maxWidth: 1280 });
});

test('a refused action asks for the missing grant, at most once a minute', async () => {
  let now = 1_000_000;
  const asked: string[] = [];
  const { run } = setup({
    screenPermission: () => 'not-determined',
    now: () => now,
    requestPermission: async (reason) => { asked.push(reason); },
  });
  await assert.rejects(run('screenshot'), (error: unknown) => error instanceof ComputerCommandError && error.code === 'computer_unavailable');
  await assert.rejects(run('click', { x: 1, y: 1 }));
  assert.deepEqual(asked, ['permission-screen'], 'an agent retrying does not stack system prompts');
  now += 61_000;
  await assert.rejects(run('screenshot'));
  assert.deepEqual(asked, ['permission-screen', 'permission-screen']);
  // Status is read by the interface every few seconds: it reports, it never asks.
  await run('status', undefined, 'human');
  assert.equal(asked.length, 2);
});
