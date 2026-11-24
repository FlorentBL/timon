/**
 * The host's own Claude sign-in kept by Timon (TODO #426), on the plugin's side: what a launch
 * of the base profile runs on when the daemon hands it that sign-in as its account, and how the
 * long-lived token `claude setup-token` prints is read off its screen.
 *
 * The screen fixtures are what Claude Code 2.1.322 drew in a 1000-column pseudo-terminal, with
 * the OAuth state and challenge replaced; the token is made up.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderContext } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
import { claudeAccountKeychainService } from '../../official-providers/provider-claude/lib/account-keychain.js';
import { claudeProjectSlug } from '../../official-providers/provider-claude/lib/profile-config.js';
import {
  claudeTokenDriver, parseSetupToken, parseSetupTokenPrompt, setupTokenRejected,
} from '../../official-providers/provider-claude/lib/setup-token.js';

const { timon: { apiVersion } } = JSON.parse(readFileSync(new URL('../../official-providers/provider-claude/package.json', import.meta.url), 'utf8')) as { timon: { apiVersion: number } };

const LONG_LIVED = 'sk-ant-oat01-LongLivedTokenMadeUpForTheTest_abcdefghijklmnopqrstuvwxyz0123456789-AAAA';
const ESC = '\u001b';
const BEL = '\u0007';
const URL_TEXT = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHALLENGE&code_challenge_method=S256&state=STATE';

/** The screen up to the code prompt: column moves for spaces, the address inside an OSC 8 link, then visible. */
const PROMPT_SCREEN = [
  `${ESC}7${ESC}[r${ESC}8${ESC}[?25h${ESC}[?25l${ESC}[?2004hWelcome${ESC}[9Gto${ESC}[12GClaude${ESC}[19GCode${ESC}[24Gv2.1.322\r\n`,
  `${ESC}[2GBrowser${ESC}[10Gdidn't${ESC}[17Gopen?${ESC}[23GUse${ESC}[27Gthe${ESC}[31Gurl${ESC}[35Gbelow${ESC}[41Gto${ESC}[44Gsign${ESC}[49Gin\r\n\r\n`,
  `${ESC}]8;id=f1lgmb;${URL_TEXT}${BEL}${ESC}[2m${URL_TEXT.slice(0, 120)}${ESC}[22m${ESC}]8;;${BEL}\r\n`,
  `${ESC}[2GPaste${ESC}[8Gcode${ESC}[13Ghere${ESC}[18Gif${ESC}[21Gprompted${ESC}[30G>`,
].join('');

const TOKEN_SCREEN = [
  `${ESC}[32m✓${ESC}[3GLong-lived${ESC}[14Gauthentication${ESC}[29Gtoken${ESC}[35Gcreated${ESC}[43Gsuccessfully!${ESC}[39m\r\n\r\n`,
  `Your${ESC}[6GOAuth${ESC}[12Gtoken${ESC}[18G(valid${ESC}[25Gfor${ESC}[29G1${ESC}[31Gyear):\r\n\r\n`,
  `${ESC}[33m${LONG_LIVED}${ESC}[39m\r\n\r\n`,
  `${ESC}[2mStore${ESC}[8Gthis${ESC}[13Gtoken${ESC}[19Gsecurely.${ESC}[22m\r\n`,
].join('');

const REJECTED_SCREEN = `${ESC}[2GPaste${ESC}[8Gcode${ESC}[13Ghere${ESC}[18Gif${ESC}[21Gprompted${ESC}[30G>\r\n ******************ate456\r\n${ESC}[31mOAuth${ESC}[7Gerror:${ESC}[14GThat${ESC}[19Gcode${ESC}[24Gwasn't${ESC}[31Gaccepted.${ESC}[39m`;

test('the page\'s address is read whole from the OSC 8 link, not from the visible slice', () => {
  assert.deepEqual(parseSetupTokenPrompt(PROMPT_SCREEN), { kind: 'paste-code', url: URL_TEXT });
  assert.equal(parseSetupTokenPrompt(PROMPT_SCREEN.slice(0, 200)), null);
  // A terminal that draws no link still prints the address as text.
  assert.deepEqual(parseSetupTokenPrompt(`Use the url below\r\n${ESC}[2m${URL_TEXT}${ESC}[22m\r\n`), { kind: 'paste-code', url: URL_TEXT });
});

test('the token is read after the line that announces it, and only there', () => {
  assert.equal(parseSetupToken(TOKEN_SCREEN), LONG_LIVED);
  assert.equal(parseSetupToken(`${PROMPT_SCREEN}\r\n sk-ant-oat01-not-announced-yet-aaaaaaaaaaaaaaaa`), null);
  assert.equal(parseSetupToken(PROMPT_SCREEN), null);
});

test('a refused code is told apart from a screen still drawing', () => {
  assert.equal(setupTokenRejected(REJECTED_SCREEN), true);
  assert.equal(setupTokenRejected(PROMPT_SCREEN), false);
  assert.equal(setupTokenRejected(TOKEN_SCREEN), false);
});

test('the driver runs setup-token in a throwaway folder, with no token of the daemon\'s, and saves through the provider\'s store', () => {
  const ctx = createProviderContext({ apiVersion, secrets: [LONG_LIVED] });
  process.on('exit', () => ctx.cleanup());
  const token = createClaudeToken(ctx.provider);
  let resets = 0;
  const driver = claudeTokenDriver(token, { resetClaudeUsageCache: () => { resets += 1; } });
  assert.deepEqual(driver.args(), ['setup-token']);
  const env = driver.env('/tmp/throwaway', { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'inherited' });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/throwaway');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(driver.stored(), false);
  driver.save(LONG_LIVED);
  assert.equal(driver.stored(), true);
  assert.equal(token.readClaudeToken(), LONG_LIVED);
  assert.equal(resets, 1);
  // What `setup-token` would never print is refused by the store's own check.
  assert.throws(() => driver.save('short'));
});

const roots: string[] = [];
process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** The base profile `claude`, with or without the host's sign-in kept by Timon as its account. */
function hostHarness(options: { kept: boolean; token?: string; platform?: NodeJS.Platform; keychain?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'timon-claude-host-'));
  roots.push(root);
  const configDir = join(root, 'backend-accounts', 'hostclaude');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const service = claudeAccountKeychainService(configDir);
  const ctx = createProviderContext({
    apiVersion, secrets: [LONG_LIVED],
    osCredentials: options.keychain === undefined ? {} : { [service]: options.keychain },
  });
  process.on('exit', () => ctx.cleanup());
  const token = createClaudeToken(ctx.provider);
  if (options.token) token.setClaudeToken(options.token);
  ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token), { platform: options.platform ?? 'linux' }));
  const dialect = ctx.registered.dialect('claude');
  const profile = options.kept
    ? { id: 'claude', cmd: 'claude', env: {}, account: { id: 'hostclaude', name: 'Claude', configDir } }
    : { id: 'claude', cmd: 'claude', env: {} };
  return {
    root, configDir, ctx, service,
    launch: (resumeSession: string | null = null, missionId = `mission-host-${roots.length}`) => dialect.buildSpawn({
      agentName: 'main', systemPrompt: 'contract', message: 'ping', resumeSession, missionId,
      cfg: { cwd: root, permission_mode: 'auto', mcp_servers: [] },
    } as never, profile as never),
  };
}

test('kept by Timon: the CLI runs on Timon\'s folder, never on ~/.claude, with no inherited token', async () => {
  const harness = hostHarness({ kept: true });
  const spec = await harness.launch();
  assert.equal(spec.env?.CLAUDE_CONFIG_DIR, harness.configDir);
  assert.equal(spec.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, harness.configDir);
  assert.equal(spec.env?.CLAUDE_CODE_OAUTH_TOKEN, '');
});

test('kept by Timon with a long-lived token: the token runs it, the sessions stay in Timon\'s folder', async () => {
  const harness = hostHarness({ kept: true, token: LONG_LIVED });
  const spec = await harness.launch();
  assert.equal(spec.env?.CLAUDE_CONFIG_DIR, harness.configDir);
  assert.equal(spec.env?.CLAUDE_CODE_OAUTH_TOKEN, LONG_LIVED);
  assert.ok(!spec.args.join(' ').includes(LONG_LIVED), 'the token never goes on the command line');
});

test('the terminal\'s session: ~/.claude as before, the long-lived token when one is kept', async () => {
  const bare = await hostHarness({ kept: false }).launch();
  assert.equal(bare.env?.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(bare.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const withToken = await hostHarness({ kept: false, token: LONG_LIVED }).launch();
  assert.deepEqual(withToken.env, { CLAUDE_CODE_OAUTH_TOKEN: LONG_LIVED });
});

test('an account instance never runs on the host\'s long-lived token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-claude-host-account-'));
  roots.push(root);
  const ctx = createProviderContext({ apiVersion, secrets: [LONG_LIVED] });
  process.on('exit', () => ctx.cleanup());
  const token = createClaudeToken(ctx.provider);
  token.setClaudeToken(LONG_LIVED);
  ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token), { platform: 'linux' }));
  const spec = await ctx.registered.dialect('claude').buildSpawn({
    agentName: 'main', systemPrompt: 'contract', message: 'ping', resumeSession: null, missionId: 'mission-account',
    cfg: { cwd: root, permission_mode: 'auto', mcp_servers: [] },
  } as never, { id: 'claude@acc1', cmd: 'claude', env: {}, account: { id: 'acc1', name: 'Work', configDir: root } } as never);
  assert.equal(spec.env?.CLAUDE_CODE_OAUTH_TOKEN, '');
});

test('a session kept in ~/.claude before the switch is brought into Timon\'s folder for --resume', async () => {
  const harness = hostHarness({ kept: true });
  const userDir = join(harness.root, 'user-claude');
  const sessionId = '0b8a6c1e-1111-4222-8333-944455556666';
  const source = join(userDir, 'projects', claudeProjectSlug(harness.root), `${sessionId}.jsonl`);
  mkdirSync(join(source, '..'), { recursive: true });
  writeFileSync(source, '{"type":"user"}\n');
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = userDir;
  try {
    const spec = await harness.launch(sessionId);
    assert.ok(spec.args.includes('--resume'));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
  }
  // The CLI files a session by its folder with links resolved: on macOS the temporary folder is reached through /var -> /private/var.
  const adopted = join(harness.configDir, 'projects', claudeProjectSlug(realpathSync.native(harness.root)), `${sessionId}.jsonl`);
  assert.ok(existsSync(adopted));
  assert.equal(readFileSync(adopted, 'utf8'), '{"type":"user"}\n');
});

test('darwin: the kept sign-in\'s keychain entry moves into Timon\'s folder before the CLI starts', async () => {
  const pair = { claudeAiOauth: { accessToken: 'sk-ant-oat01-host-access-for-the-test', refreshToken: 'sk-ant-ort01-host-refresh-for-the-test', expiresAt: Date.now() + 3_600_000 } };
  const harness = hostHarness({ kept: true, platform: 'darwin', keychain: JSON.stringify(pair) });
  await harness.launch();
  const file = JSON.parse(readFileSync(join(harness.configDir, '.credentials.json'), 'utf8')) as typeof pair;
  assert.equal(file.claudeAiOauth.refreshToken, pair.claudeAiOauth.refreshToken);
});

/** The provider's own check (C4), as the setup row and the providers list read it before offering anything. */
async function detect(options: { file?: unknown; keychain?: string; token?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'timon-claude-detect-'));
  roots.push(root);
  if (options.file !== undefined) writeFileSync(join(root, '.credentials.json'), JSON.stringify(options.file));
  const ctx = createProviderContext({
    apiVersion, secrets: [LONG_LIVED],
    osCredentials: options.keychain === undefined ? {} : { 'Claude Code-credentials': options.keychain },
  });
  process.on('exit', () => ctx.cleanup());
  const token = createClaudeToken(ctx.provider);
  if (options.token) token.setClaudeToken(options.token);
  const usage = createClaudeUsage(ctx.provider, token);
  return usage.claudeAuthStatus({ CLAUDE_CONFIG_DIR: root });
}

const SESSION = { claudeAiOauth: { accessToken: 'sk-ant-oat01-terminal-access', refreshToken: 'sk-ant-ort01-terminal-refresh', expiresAt: Date.now() + 3_600_000 } };

test('detection: a terminal session in the CLI\'s folder (Linux, Windows) is used as it is', async () => {
  const status = await detect({ file: SESSION });
  assert.equal(status.ok, true);
  assert.equal(status.source, 'file');
});

test('detection: no session anywhere says how to sign in, which the app turns into its browser sign-in', async () => {
  const status = await detect({});
  assert.equal(status.ok, false);
  assert.equal(status.signInCommand, 'claude');
});

test('detection: macOS, a session only in the login keychain is found, read and never written', async () => {
  const status = await detect({ keychain: JSON.stringify(SESSION) });
  assert.equal(status.ok, true);
  assert.match(status.detail, /keychain/);
  // A signed-out keychain entry is no session.
  assert.equal((await detect({ keychain: JSON.stringify({ claudeAiOauth: {} }) })).ok, false);
});

test('detection: a long-lived token kept by Timon counts as signed in, and nothing of it is said', async () => {
  const status = await detect({ token: LONG_LIVED });
  assert.equal(status.ok, true);
  assert.ok(!JSON.stringify(status).includes(LONG_LIVED));
});
