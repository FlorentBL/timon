/**
 * End-to-end test of computer use on a real display: `npm run test:computer-use-e2e` (in desktop/).
 *
 * Electron starts the real service (the same `startComputerUse` the app runs), opens a window with a
 * textarea, then acts as the AGENT over the private HTTP transport: screenshot, click, type, shortcut,
 * and reads what really landed in the textarea. It finishes by pressing the stop shortcut through the
 * service itself and checks that the next agent command is refused.
 *
 * It types and clicks on the real screen, so it only runs on CI or when TIMON_COMPUTER_USE_E2E=1.
 * On macOS without the Screen Recording / Accessibility grants it checks the clean refusal and passes
 * with "skipped: permissions".
 */
import { app, BrowserWindow } from 'electron';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.env.TIMON_E2E_REPORT || join(root, 'computer-use-e2e-report.txt');
const lines = [];
function log(message) {
  lines.push(message);
  console.log(message);
}

if (process.env.CI !== 'true' && process.env.TIMON_COMPUTER_USE_E2E !== '1') {
  console.error('Refusing to run: this test types and clicks on the real screen. Set TIMON_COMPUTER_USE_E2E=1 to run it on purpose.');
  process.exit(2);
}

// Sandboxed chromium needs a SUID helper that CI images do not have; a headless virtual display has no GPU.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
}

const TYPED = 'hello timon 123';
// The agent's allowed applications: the Electron binary this test runs under, by each of its names.
const ALLOWED = [...new Set(['Electron', 'electron', 'com.github.Electron', basename(process.execPath), app.getName()])];
const timings = [];
let exitCode = 1;
let home = null;
let desktop = null;
let win = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function finish(code) {
  exitCode = code;
  try { await desktop?.close(); } catch { /* Best effort: the process exits next. */ }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* Same. */ }
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  await writeFile(reportPath, `${lines.join('\n')}\n`).catch(() => {});
  app.exit(exitCode);
}

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  return error;
}

async function main() {
  // The service reads the provider descriptor from this home, never the real one.
  home = await mkdtemp(join(tmpdir(), 'timon-cu-e2e-'));
  process.env.TIMON_HOME = home;
  await app.whenReady();

  const { startComputerUse, COMPUTER_STOP_SHORTCUT } = await import('../dist-e2e/computer-use-electron.js');
  desktop = await startComputerUse(home, (key) => key);
  const provider = JSON.parse(await readFile(join(home, 'computer-native', 'provider.json'), 'utf8'));

  async function send(command, args, actor = 'agent', label = command, allowedApps = ALLOWED) {
    const started = performance.now();
    const response = await fetch(`${provider.origin}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.token}` },
      body: JSON.stringify({ command, args, actor, allowedApps }),
    });
    const body = await response.json();
    const ms = Math.round(performance.now() - started);
    timings.push({ label, ms, status: response.status });
    log(`  ${label.padEnd(34)} ${String(ms).padStart(6)} ms  (HTTP ${response.status})`);
    return { status: response.status, body };
  }
  async function agent(command, args, label) {
    const { status, body } = await send(command, args, 'agent', label);
    if (status !== 200 || !body.ok) throw fail(`${label ?? command} failed: HTTP ${status} ${JSON.stringify({ ...body, result: undefined })}`);
    return body.result;
  }

  log(`computer-use e2e on ${process.platform} (${process.arch}), electron ${process.versions.electron}`);
  const status = await agent('status', {}, 'status');
  log(`  display ${status.display.width}x${status.display.height} @${status.display.scaleFactor}, available=${status.available}${status.reason ? ` (${status.reason})` : ''}`);
  if (!status.available) {
    if (process.platform === 'darwin' && String(status.reason).startsWith('permission-')) {
      // The clean refusal: an action must be refused with a reason, never performed or crashed.
      const refused = await send('click', { x: 1, y: 1 }, 'agent', 'click (refused)');
      if (refused.status !== 503 || refused.body.code !== 'computer_unavailable') throw fail(`Expected a clean 503 refusal, got ${JSON.stringify(refused)}`);
      log('skipped: permissions');
      return 0;
    }
    throw fail(`Computer use should be available here, got reason=${status.reason}`);
  }
  if (status.stopped) throw fail('Service starts stopped.');

  win = new BrowserWindow({
    x: 120, y: 120, width: 640, height: 420, show: true, alwaysOnTop: true, frame: true, resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const page = '<!doctype html><meta charset="utf-8"><title>timon e2e</title><body style="margin:0"><textarea id="t" style="position:absolute;left:40px;top:40px;width:480px;height:240px;font-size:24px"></textarea></body>';
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  win.show();
  win.focus();
  const js = (code) => win.webContents.executeJavaScript(code);
  const value = () => js('document.getElementById("t").value');
  async function expectValue(expected, label) {
    const deadline = Date.now() + 5000;
    let current = await value();
    while (current !== expected && Date.now() < deadline) { await sleep(100); current = await value(); }
    if (current !== expected) throw fail(`${label}: the textarea holds ${JSON.stringify(current)}, expected ${JSON.stringify(expected)}`);
    log(`  ✓ ${label}: ${JSON.stringify(current)}`);
  }
  await sleep(500);

  const shot = await agent('screenshot', { maxWidth: 1280 }, 'screenshot');
  const png = Buffer.from(shot.data, 'base64');
  // JPEG starts with FF D8 FF; PNG, the fallback when the JPEG encoder gives nothing, with 89 'PNG'.
  const isJpeg = png[0] === 0xff && png[1] === 0xd8 && png[2] === 0xff;
  const isPng = png.subarray(1, 4).toString('latin1') === 'PNG';
  if (png.length < 1000 || !(shot.mimeType === 'image/jpeg' ? isJpeg : shot.mimeType === 'image/png' && isPng)) {
    throw fail(`Screenshot is not a plausible image (${shot.mimeType}, ${png.length} bytes).`);
  }
  log(`  format ${shot.mimeType}`);
  if (process.env.TIMON_E2E_REQUIRE_JPEG === '1' && shot.mimeType !== 'image/jpeg') {
    throw fail('The capture fell back to PNG: the JPEG encoder gave nothing on this system.');
  }
  const ratio = (shot.width / shot.height) / (status.display.width / status.display.height);
  if (Math.abs(ratio - 1) > 0.01 || shot.width > 1280) throw fail(`Screenshot size ${shot.width}x${shot.height} does not match the display ${status.display.width}x${status.display.height}.`);
  log(`  screenshot ${shot.width}x${shot.height}, ${png.length} bytes`);

  // Window content origin and textarea box are in points; the agent works in the screenshot's pixels.
  const box = await js('(() => { const r = document.getElementById("t").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
  const content = win.getContentBounds();
  const toImage = (point) => ({
    x: Math.round((content.x + point.x) * shot.width / status.display.width),
    y: Math.round((content.y + point.y) * shot.height / status.display.height),
  });
  const target = toImage(box);
  log(`  textarea centre: screen ${content.x + box.x},${content.y + box.y} points -> image ${target.x},${target.y}`);
  const selectAll = process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a';

  log('variant 1: type, select all, delete, type');
  await agent('click', { x: target.x, y: target.y }, 'click');
  await agent('type', { text: TYPED }, 'type');
  await expectValue(TYPED, 'typed text arrived');
  await agent('key', { keys: selectAll }, `key ${selectAll}`);
  await agent('key', { keys: 'Backspace' }, 'key Backspace');
  await expectValue('', 'select all + delete cleared it');
  await agent('type', { text: 'ok' }, 'type');
  await expectValue('ok', 'final text');

  log('variant 2: without select all the full text stays');
  await js('document.getElementById("t").value = ""');
  await agent('click', { x: target.x, y: target.y }, 'click');
  await agent('type', { text: TYPED }, 'type');
  await expectValue(TYPED, 'full text');

  log('allowed applications: the guard refuses what is not listed');
  for (const [label, list] of [['empty list', []], ['other application', ['definitely-not-this-app']]]) {
    const refusedClick = await send('click', { x: target.x, y: target.y }, 'agent', `click (${label})`, list);
    if (refusedClick.status !== 403 || refusedClick.body.code !== 'computer_app_not_allowed') throw fail(`With an ${label} a click must get computer_app_not_allowed, got ${JSON.stringify(refusedClick)}`);
    const refusedType = await send('type', { text: 'LEAK' }, 'agent', `type (${label})`, list);
    if (refusedType.status !== 403 || refusedType.body.code !== 'computer_app_not_allowed') throw fail(`With an ${label} typing must be refused, got ${JSON.stringify(refusedType)}`);
    log(`  ✓ ${label}: ${refusedType.body.error}`);
  }
  await expectValue(TYPED, 'nothing was typed by the refused actions');
  // Reading stays open: a capture and a window list work with an empty list.
  await agent('screenshot', { maxWidth: 256 }, 'screenshot (any list)');

  log('list_windows and focus_window');
  const windowsOf = async (allowedApps = ALLOWED) => {
    const { status, body } = await send('list_windows', {}, 'agent', 'list_windows', allowedApps);
    if (status !== 200 || !body.ok) throw fail(`list_windows failed: HTTP ${status} ${JSON.stringify(body)}`);
    return body.result;
  };
  const ours = (list) => list.find((w) => typeof w.title === 'string' && w.title.includes('timon e2e'));
  const listed = await windowsOf([]);
  const mine = ours(listed);
  if (!mine) throw fail(`The test window is not in list_windows: ${JSON.stringify(listed.map((w) => w.title))}`);
  log(`  ✓ listed: ${JSON.stringify(mine)}`);
  // Put another window in front, then ask for ours back.
  const other = new BrowserWindow({ x: 200, y: 200, width: 400, height: 300, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await other.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>timon e2e other</title><body>other</body>')}`);
  other.show();
  other.focus();
  await sleep(700);
  const refusedFocus = await send('focus_window', { id: mine.id }, 'agent', 'focus_window (not allowed)', ['definitely-not-this-app']);
  if (refusedFocus.status !== 403 || refusedFocus.body.code !== 'computer_app_not_allowed') throw fail(`focus_window must be refused for an unlisted application, got ${JSON.stringify(refusedFocus)}`);
  await agent('focus_window', { id: mine.id }, 'focus_window');
  let focusedNow = false;
  const focusDeadline = Date.now() + 5000;
  while (!focusedNow && Date.now() < focusDeadline) {
    focusedNow = ours(await windowsOf())?.focused === true;
    if (!focusedNow) await sleep(250);
  }
  if (!focusedNow) throw fail('focus_window did not bring the test window to the front (list_windows never reported it focused).');
  log('  ✓ focus_window brought the test window to the front');
  other.destroy();
  win.focus();
  await sleep(300);

  log(`stop: pressing ${COMPUTER_STOP_SHORTCUT} through the service`);
  await agent('key', { keys: COMPUTER_STOP_SHORTCUT }, 'key (stop shortcut)');
  const deadline = Date.now() + 5000;
  let stopped = false;
  while (!stopped && Date.now() < deadline) {
    stopped = (await send('status', {}, 'human', 'status (poll)')).body.result?.stopped === true;
    if (!stopped) await sleep(200);
  }
  if (!stopped) throw fail('The stop shortcut did not stop the service (status.stopped stayed false): the global shortcut was not received.');
  const refused = await send('click', { x: target.x, y: target.y }, 'agent', 'click (after stop)');
  if (refused.status !== 409 || refused.body.code !== 'computer_stopped') throw fail(`After stop the agent must get computer_stopped, got ${JSON.stringify(refused)}`);
  await expectValue(TYPED, 'nothing changed after stop');
  log('  ✓ agent refused with computer_stopped');

  const slowest = timings.reduce((a, b) => (b.ms > a.ms ? b : a));
  log(`slowest action: ${slowest.label} ${slowest.ms} ms; total ${timings.reduce((sum, t) => sum + t.ms, 0)} ms over ${timings.length} commands`);
  log('PASS');
  return 0;
}

const watchdog = setTimeout(() => {
  log('FAIL: timed out after 240 s');
  void finish(1);
}, 240_000);
watchdog.unref();

main().then(
  (code) => finish(code),
  (error) => {
    log(`FAIL: ${error instanceof Error ? (error.expected ? error.message : error.stack ?? error.message) : String(error)}`);
    return finish(1);
  },
);
