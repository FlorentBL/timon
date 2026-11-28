/**
 * `timon-desktop --browser-host` for real, on a machine with no screen: the shell's own `main.js`
 * transpiled into a temporary copy of the repository's layout, started by Electron with no
 * DISPLAY and no WAYLAND_DISPLAY whatever the machine has. Opt-in, like every Electron smoke.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { smokeElectron } from './electron-binary.fixture.js';

const SMOKE = process.env.TIMON_ELECTRON_SMOKE === '1';
const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(DESKTOP, 'src');

/** The shell as `tsc` would emit it, beside the folders `main.js` reads from (`../scripts`, `../../app`). */
async function writeShell(root: string): Promise<string> {
  const desktop = join(root, 'desktop');
  const dist = join(desktop, 'dist');
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isFile() || name.endsWith('.test.ts') || name.endsWith('.fixture.ts')) continue;
    const cjs = name.endsWith('.cts');
    if (!cjs && !name.endsWith('.ts')) continue;
    const output = ts.transpileModule(readFileSync(join(entry.parentPath, name), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: cjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext },
    }).outputText;
    const target = join(dist, relative(SRC, entry.parentPath));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, name.replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js')), output);
  }
  await copyFile(join(DESKTOP, 'package.json'), join(desktop, 'package.json'));
  await symlink(join(DESKTOP, 'node_modules'), join(desktop, 'node_modules'), 'junction');
  await symlink(join(DESKTOP, 'scripts'), join(desktop, 'scripts'), 'junction');
  await symlink(join(DESKTOP, '..', 'app'), join(root, 'app'), 'junction');
  return join(dist, 'main.js');
}

/** The environment of a machine with no screen. */
function screenless(home: string): NodeJS.ProcessEnv {
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
  return { ...env, TIMON_HOME: home };
}

interface Started { child: ChildProcess; output: () => string; exited: Promise<number | null> }

function launch(args: string[], env: NodeJS.ProcessEnv): Started {
  const child = spawn(smokeElectron(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return { child, output: () => output, exited };
}

async function until<T>(read: () => T | null | undefined, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

type Descriptor = { origin: string; token: string; pid: number };
const descriptorOf = (home: string): Descriptor | null => {
  try { return JSON.parse(readFileSync(join(home, 'browser-native', 'provider.json'), 'utf8')) as Descriptor; } catch { return null; }
};

function client(descriptor: Descriptor) {
  return async (body: Record<string, unknown>): Promise<Record<string, unknown> & { status: number }> => {
    const response = await fetch(`${descriptor.origin}/command`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({ profileId: 'profile-a', ...body }),
    });
    return { status: response.status, ...(await response.json() as Record<string, unknown>) };
  };
}

function page(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Host page</title><body style="margin:0;background:rgb(30,120,200)">'
      + '<h1 style="color:white;font-family:sans-serif">No screen</h1><canvas width="300" height="100"></canvas>'
      + '<script>const c=document.querySelector("canvas").getContext("2d");let x=0;setInterval(()=>{c.fillStyle="rgb("+(x++%255)+",200,50)";c.fillRect(0,0,300,100)},33)</script></body>');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/` });
  }));
}

/** A second Electron playing the remote panel: it offers WebRTC through the provider and counts the frames it decodes. */
const RECEIVER = String.raw`
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
app.on('window-all-closed', () => {});
app.setPath('userData', process.env.RECEIVER_PROFILE);
(async () => {
  await app.whenReady();
  const p = JSON.parse(readFileSync(process.env.TIMON_HOME + '/browser-native/provider.json', 'utf8'));
  const cmd = async (body) => (await fetch(p.origin + '/command', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.token }, body: JSON.stringify({ profileId: 'profile-a', mediaActor: 'remote-panel-smoke', ...body }) })).json();
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await w.loadURL('data:text/html,<video autoplay muted playsinline></video>');
  const offer = await w.webContents.executeJavaScript('(async()=>{window.pc=new RTCPeerConnection({iceServers:[]});window.stream=new MediaStream();pc.ontrack=e=>{stream.addTrack(e.track);const v=document.querySelector("video");v.srcObject=stream;v.play()};pc.addTransceiver("video",{direction:"recvonly"});await pc.setLocalDescription(await pc.createOffer());await new Promise(r=>{if(pc.iceGatheringState==="complete")return r();pc.addEventListener("icegatheringstatechange",()=>{if(pc.iceGatheringState==="complete")r()})});return{type:pc.localDescription.type,sdp:pc.localDescription.sdp}})()', true);
  const rtc = await cmd({ action: 'mediaOffer', offer, audio: false });
  if (!rtc.answer) throw new Error('no answer: ' + JSON.stringify(rtc));
  await w.webContents.executeJavaScript('pc.setRemoteDescription(' + JSON.stringify(rtc.answer) + ')');
  let stats;
  for (let i = 0; i < 150; i++) { stats = await w.webContents.executeJavaScript('(async()=>{const v=[...(await pc.getStats()).values()].find(x=>x.type==="inbound-rtp"&&x.kind==="video");return{frames:v?.framesDecoded||0,width:v?.frameWidth||0}})()'); if (stats.frames > 5) break; await new Promise(r => setTimeout(r, 100)); }
  const center = await w.webContents.executeJavaScript('(()=>{const v=document.querySelector("video"),c=document.createElement("canvas");c.width=c.height=1;const x=c.getContext("2d");x.drawImage(v,v.videoWidth/2,v.videoHeight/2,1,1,0,0,1,1);return[...x.getImageData(0,0,1,1).data]})()');
  await cmd({ action: 'mediaStop', mediaId: rtc.mediaId });
  console.log('RECEIVER ' + JSON.stringify({ ...stats, center }));
  app.exit(0);
})().catch(error => { console.log('RECEIVER_FAILED ' + (error && error.stack || error)); app.exit(1); });
`;

/** An Electron playing the application on the same home: the lock request and the takeover of `main.ts`. */
const APPLICATION = String.raw`
import { app } from 'electron';
import { join, relative } from 'node:path';
const { takeHomeFromBrowserHost, launchedByBrowserHost } = await import(process.env.HOST_MODULE);
const home = process.env.TIMON_HOME;
app.setPath('userData', join(home, 'desktop-profile'));
app.on('window-all-closed', () => {});
const launch = { build: 'smoke-application' };
let held = app.requestSingleInstanceLock(launch);
const first = held;
if (!held) held = await takeHomeFromBrowserHost({ home, pid: process.pid, request: () => app.requestSingleInstanceLock(launch) });
let hostAsks = 0;
app.on('second-instance', (_event, _argv, _cwd, data) => { if (launchedByBrowserHost(data)) hostAsks++; });
console.log('APPLICATION ' + JSON.stringify({ first, held }));
process.stdin.on('data', () => { console.log('APPLICATION_QUITS ' + JSON.stringify({ hostAsks })); app.exit(0); });
`;

test('--browser-host serves the built-in browser with no screen, streams it, refuses the Chrome sign-in and stops on SIGTERM', {
  skip: !SMOKE || process.platform !== 'linux', timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'timon-browser-host-smoke-'));
  const home = join(root, 'home');
  await mkdir(home);
  const { server, url } = await page();
  let host: Started | null = null;
  try {
    const main = await writeShell(root);
    host = launch([main, '--browser-host'], screenless(home));
    const started = host;
    const descriptor = await until(() => descriptorOf(home), 'provider.json').catch((error: Error) => { throw new Error(`${error.message}: ${started.output()}`); });
    assert.equal(descriptor.pid, host.child.pid, 'the headless start replaced the process, same PID');
    assert.match(host.output(), /starting again on the headless platform/);
    assert.equal(JSON.parse(readFileSync(join(home, 'browser-native', 'browser-host.json'), 'utf8')).pid, host.child.pid);
    // No desktop to drive: the daemon must find no computer use provider on a host.
    assert.equal(existsSync(join(home, 'computer-native')), false, 'a browser host started computer use');
    const cmd = client(descriptor);
    assert.equal((await cmd({ action: 'start' })).status, 200);
    assert.equal((await cmd({ action: 'navigate', url })).status, 200);
    let title = '';
    for (let i = 0; i < 100 && title !== 'Host page'; i++) {
      title = String((await cmd({ action: 'evaluate', expression: 'document.title' })).result);
      if (title !== 'Host page') await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(title, 'Host page');
    const state = await cmd({ action: 'evaluate', expression: '[innerWidth, innerHeight, document.visibilityState].join(" ")' });
    assert.equal(state.result, '1366 768 visible');
    const shot = await cmd({ action: 'screenshot' });
    assert.equal(shot.status, 200, String(shot.error));
    assert.equal(shot.width, 1366);
    assert.ok(Buffer.from(String(shot.data), 'base64').length > 1000);

    const encoded = await cmd({ action: 'mediaStart', mediaActor: 'viewer-smoke-one', audio: false });
    assert.match(String(encoded.mimeType), /video\/(webm|mp4)/);
    let bytes = 0;
    for (let i = 0; i < 10 && bytes < 1000; i++) {
      bytes += Buffer.from(String((await cmd({ action: 'mediaRead', mediaId: encoded.mediaId, mediaActor: 'viewer-smoke-one' })).data ?? ''), 'base64').length;
    }
    assert.ok(bytes > 1000, `encoded stream: ${bytes} bytes`);
    await cmd({ action: 'mediaStop', mediaId: encoded.mediaId, mediaActor: 'viewer-smoke-one' });

    await writeFile(join(root, 'receiver.cjs'), RECEIVER);
    const receiver = launch(['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', join(root, 'receiver.cjs')],
      { ...screenless(home), RECEIVER_PROFILE: join(root, 'receiver-profile') });
    assert.equal(await receiver.exited, 0, receiver.output());
    const received = JSON.parse(/RECEIVER (\{.*\})/.exec(receiver.output())![1]!) as { frames: number; width: number; center: number[] };
    assert.ok(received.frames > 5, JSON.stringify(received));
    assert.equal(received.width, 1366);
    assert.ok(Math.abs(received.center[0]! - 30) < 25 && Math.abs(received.center[2]! - 200) < 25, `the page's own colour: ${JSON.stringify(received)}`);

    const signin = await cmd({ action: 'chromeSigninStart', executable: '/usr/bin/google-chrome', url: 'https://accounts.google.com/' });
    assert.equal(signin.status, 409);
    assert.equal(signin.code, 'browser_signin_needs_screen');

    host.child.kill('SIGTERM');
    assert.equal(await host.exited, 0, host.output());
    assert.equal(existsSync(join(home, 'browser-native', 'provider.json')), false);
    assert.equal(existsSync(join(home, 'browser-native', 'browser-host.json')), false);
    host = null;
  } finally {
    if (host) { host.child.kill('SIGKILL'); await host.exited; }
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the application with a screen takes the home from the host, which waits and serves again once it quits', {
  skip: !SMOKE || process.platform !== 'linux', timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'timon-browser-host-lock-smoke-'));
  const home = join(root, 'home');
  await mkdir(home);
  const running: Started[] = [];
  try {
    const main = await writeShell(root);
    const first = launch([main, '--browser-host'], screenless(home));
    running.push(first);
    await until(() => descriptorOf(home), 'the first host');
    await writeFile(join(root, 'application.mjs'), APPLICATION);
    const application = spawn(smokeElectron(), ['--ozone-platform=headless', join(root, 'application.mjs')],
      { env: { ...screenless(home), HOST_MODULE: join(root, 'desktop', 'dist', 'browser-host.js') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let applicationOutput = '';
    application.stdout.on('data', (chunk: Buffer) => { applicationOutput += chunk.toString(); });
    application.stderr.on('data', (chunk: Buffer) => { applicationOutput += chunk.toString(); });
    const applicationExited = new Promise<number | null>(resolve => application.once('exit', resolve));

    assert.equal(await first.exited, 75, first.output());
    await until(() => /APPLICATION \{/.test(applicationOutput), 'the application');
    assert.deepEqual(JSON.parse(/APPLICATION (\{.*\})/.exec(applicationOutput)![1]!), { first: false, held: true }, applicationOutput);
    assert.equal(descriptorOf(home), null, 'the host that stepped aside removed its descriptor');

    // Its service starts it again at once: it waits while the application runs.
    const second = launch([main, '--browser-host'], screenless(home));
    running.push(second);
    await until(() => /waiting for it to quit/.test(second.output()), 'the waiting host');
    assert.equal(descriptorOf(home), null);
    await new Promise(resolve => setTimeout(resolve, 6_000));
    application.stdin.write('quit\n');
    assert.equal(await applicationExited, 0, applicationOutput);
    assert.ok(JSON.parse(/APPLICATION_QUITS (\{.*\})/.exec(applicationOutput)![1]!).hostAsks >= 1,
      'the application saw the waiting host ask, and ignored it');
    const after = await until(() => descriptorOf(home), 'the host serving again', 20_000);
    assert.equal(after.pid, second.child.pid);
    second.child.kill('SIGTERM');
    assert.equal(await second.exited, 0);
  } finally {
    for (const started of running) if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
