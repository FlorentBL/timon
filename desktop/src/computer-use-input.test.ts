import assert from 'node:assert/strict';
import test from 'node:test';
import { imageToPoints, pointsToImage, screenshotSize } from './computer-use-geometry.js';
import { MAC_INPUT_SCRIPT, WINDOWS_INPUT_SCRIPT, WINDOWS_WORKER_SCRIPT, buildInputCommand, parseKeys } from './computer-use-input.js';
import { ComputerCommandError } from './computer-use-protocol.js';

const retina = { width: 1440, height: 900, scaleFactor: 2 };
const NASTY = `'; rm -rf ~ #" $(touch /tmp/pwn) \`id\` \\ \n\t é 😀 -- --version`; // french-ok: non-ASCII input must survive escaping

test('screenshot size keeps the ratio, never upscales, and conversions round-trip on Retina', () => {
  assert.deepEqual(screenshotSize(retina, 1280), { width: 1280, height: 800 });
  assert.deepEqual(screenshotSize({ width: 800, height: 600, scaleFactor: 1 }, 1280), { width: 800, height: 600 });
  const image = screenshotSize(retina, 1280);
  assert.deepEqual(imageToPoints(retina, image, 640, 400), { x: 720, y: 450 });
  assert.deepEqual(pointsToImage(retina, image, 720, 450), { x: 640, y: 400 });
  // A coordinate outside the image is clamped on the display, never beyond it.
  assert.deepEqual(imageToPoints(retina, image, 99999, -5), { x: 1439, y: 0 });
});

test('key names: modifiers, aliases and refusals', () => {
  assert.deepEqual(parseKeys('Cmd+Shift+T'), { modifiers: ['meta', 'shift'], key: 't' });
  assert.deepEqual(parseKeys('Return'), { modifiers: [], key: 'enter' });
  assert.deepEqual(parseKeys('ctrl++'), { modifiers: ['ctrl'], key: '+' });
  for (const bad of ['ctrl', 'a+b', 'ctrl+nope', 'ctrl+', '']) assert.throws(() => parseKeys(bad), ComputerCommandError, bad);
});

test('macOS: fixed script, steps as one JSON argument, text never in the script', () => {
  const command = buildInputCommand('darwin', { kind: 'type', text: NASTY }, retina);
  assert.equal(command.file, 'osascript');
  assert.deepEqual(command.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.equal(command.args[3], MAC_INPUT_SCRIPT);
  const steps = JSON.parse(command.args[4]!);
  assert.equal(steps.filter((s: { t: string }) => s.t === 'text').map((s: { s: string }) => s.s).join(''), NASTY.replace(/[\n\t]/g, ''));
  assert.ok(steps.some((s: { t: string; code: number }) => s.t === 'keycode' && s.code === 36), 'newline is a Return key press');
  assert.ok(steps.some((s: { t: string; code: number }) => s.t === 'keycode' && s.code === 48), 'tab is a Tab key press');
  assert.equal(command.args.length, 5);
});

test('macOS: click, double click, drag, key, scroll steps', () => {
  const steps = (action: Parameters<typeof buildInputCommand>[1]) => JSON.parse(buildInputCommand('darwin', action, retina).args[4]!);
  assert.deepEqual(steps({ kind: 'click', x: 10, y: 20, button: 'right', count: 1 }),
    [{ t: 'move', x: 10, y: 20 }, { t: 'down', b: 'right', n: 1 }, { t: 'up', b: 'right', n: 1 }]);
  const double = steps({ kind: 'click', x: 1, y: 2, button: 'left', count: 2 });
  assert.deepEqual(double.filter((s: { t: string }) => s.t === 'down').map((s: { n: number }) => s.n), [1, 2]);
  const drag = steps({ kind: 'drag', fromX: 0, fromY: 0, toX: 80, toY: 40 });
  assert.equal(drag.at(-1).t, 'up');
  assert.deepEqual(drag.filter((s: { t: string }) => s.t === 'drag').at(-1), { t: 'drag', x: 80, y: 40 });
  // The modifier key itself goes down first and up last: apps ignore a flag with no pressed key.
  assert.deepEqual(steps({ kind: 'key', keys: 'cmd+c' }), [
    { t: 'key', code: 55, flags: 0x100000, down: true },
    { t: 'key', code: 8, flags: 0x100000, down: true }, { t: 'key', code: 8, flags: 0x100000, down: false },
    { t: 'key', code: 55, flags: 0, down: false }]);
  assert.deepEqual(steps({ kind: 'key', keys: 'cmd+shift+t' }).map((s: { code: number; down: boolean }) => [s.code, s.down]),
    [[55, true], [56, true], [17, true], [17, false], [56, false], [55, false]]);
  // DOM scroll down is a negative wheel value.
  assert.deepEqual(steps({ kind: 'scroll', x: 5, y: 5, deltaX: 0, deltaY: 3 }).at(-1), { t: 'wheel', dx: 0, dy: -3 });
});

test('Windows: fixed encoded script, steps in the environment, absolute normalised coordinates', () => {
  const command = buildInputCommand('win32', { kind: 'type', text: NASTY }, retina);
  assert.equal(command.file, 'powershell.exe');
  assert.deepEqual(command.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.equal(command.env!.TIMON_CU_SCRIPT, WINDOWS_INPUT_SCRIPT);
  // A command line is capped at 32 767 characters on Windows: the long script must not be on it.
  for (const args of [command.args, command.worker!.args]) assert.ok(args.join(' ').length < 2000, 'the script is not on the command line');
  assert.equal(command.args.join(' ').includes('rm -rf'), false);
  // The persistent form: same fixed script family, the request is one JSON line, never code.
  assert.equal(command.worker!.env!.TIMON_CU_SCRIPT, WINDOWS_WORKER_SCRIPT);
  assert.ok(WINDOWS_WORKER_SCRIPT.length < 32_000, 'an environment variable holds 32 767 characters at most');
  assert.equal(command.worker!.input, command.env!.TIMON_CU_STEPS);
  assert.equal(command.worker!.input.includes('\n'), false);
  assert.equal(/[^\x20-\x7e]/.test(command.worker!.input), false, 'ASCII only: the console code page cannot alter it');
  const steps = JSON.parse(command.env!.TIMON_CU_STEPS!) as Array<{ t: string; unit?: number; up?: boolean }>;
  const typed = steps.filter((s) => s.t === 'unicode' && !s.up).map((s) => String.fromCharCode(s.unit!)).join('');
  assert.equal(typed, NASTY.replace(/[\n\t]/g, ''));
  const click = JSON.parse(buildInputCommand('win32', { kind: 'click', x: 720, y: 450, button: 'left', count: 1 }, retina).env!.TIMON_CU_STEPS!);
  assert.deepEqual(click[0], { t: 'move', x: 32768, y: 32768 });
  const key = JSON.parse(buildInputCommand('win32', { kind: 'key', keys: 'ctrl+shift+t' }, retina).env!.TIMON_CU_STEPS!);
  assert.deepEqual(key.map((s: { vk: number; up: boolean }) => [s.vk, s.up]),
    [[0x11, false], [0x10, false], [0x54, false], [0x54, true], [0x10, true], [0x11, true]]);
});

test('Windows: coordinates go through the physical pixel, so 125 % and 150 % displays land on it', () => {
  const move = (display: { width: number; height: number; scaleFactor: number }, x: number, y: number) =>
    JSON.parse(buildInputCommand('win32', { kind: 'move', x, y }, display).env!.TIMON_CU_STEPS!)[0] as { x: number; y: number };
  // Windows reads value → floor(value × physical / 65536): the round trip must give the pixel back.
  for (const display of [{ width: 1536, height: 864, scaleFactor: 1.25 }, { width: 1280, height: 720, scaleFactor: 1.5 }, { width: 1920, height: 1080, scaleFactor: 1 }]) {
    const physical = { x: Math.round(display.width * display.scaleFactor), y: Math.round(display.height * display.scaleFactor) };
    for (const [px, py] of [[0, 0], [1, 1], [333, 217], [physical.x - 1, physical.y - 1]] as const) {
      const sent = move(display, px / display.scaleFactor, py / display.scaleFactor);
      assert.equal(Math.floor(sent.x * physical.x / 65536), px, `x ${px} at ${display.scaleFactor}`);
      assert.equal(Math.floor(sent.y * physical.y / 65536), py, `y ${py} at ${display.scaleFactor}`);
    }
  }
  assert.deepEqual(move({ width: 100, height: 100, scaleFactor: 1 }, 5000, -5), { t: 'move', x: 64881, y: 0 });
});

test('Linux: argv only, text behind "--", coordinates in physical pixels', () => {
  const type = buildInputCommand('linux', { kind: 'type', text: NASTY }, retina);
  assert.equal(type.file, 'xdotool');
  assert.deepEqual(type.args.slice(0, 5), ['type', '--clearmodifiers', '--delay', '8', '--']);
  assert.equal(type.args[5], NASTY);
  assert.equal(type.args.length, 6);
  assert.deepEqual(buildInputCommand('linux', { kind: 'click', x: 10, y: 20, button: 'middle', count: 2 }, retina).args,
    ['mousemove', '20', '40', 'click', '--repeat', '2', '--delay', '40', '2']);
  assert.deepEqual(buildInputCommand('linux', { kind: 'key', keys: 'ctrl+Enter' }, retina).args, ['key', '--clearmodifiers', '--', 'ctrl+Return']);
  assert.deepEqual(buildInputCommand('linux', { kind: 'scroll', x: 1, y: 1, deltaX: 0, deltaY: -2 }, { ...retina, scaleFactor: 1 }).args,
    ['mousemove', '1', '1', 'click', '--repeat', '2', '4']);
  assert.deepEqual(buildInputCommand('linux', { kind: 'drag', fromX: 0, fromY: 0, toX: 5, toY: 6 }, { ...retina, scaleFactor: 1 }).args,
    ['mousemove', '0', '0', 'mousedown', '1', 'mousemove', '5', '6', 'mouseup', '1']);
});

test('the Windows worker answers reads on one ASCII JSON line and the one-shot form runs the same query', async () => {
  const { WINDOWS_WORKER_SCRIPT, WINDOWS_QUERY_SCRIPT, windowsQueryCommand } = await import('./computer-use-input.js');
  for (const script of [WINDOWS_WORKER_SCRIPT, WINDOWS_QUERY_SCRIPT]) {
    for (const piece of ['EnumWindows', 'GetForegroundWindow', 'SetForegroundWindow', 'Invoke-TimonQuery']) assert.ok(script.includes(piece), piece);
  }
  assert.ok(WINDOWS_WORKER_SCRIPT.includes('\\u{0:x4}'), 'non-ASCII titles are escaped before they leave the worker');
  const command = windowsQueryCommand({ q: 'focus', id: '42' });
  assert.equal(command.worker?.input, '{"q":"focus","id":"42"}');
  assert.equal(command.worker?.reply, true);
});
