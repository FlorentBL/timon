import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acpAction, acpStateLine, binaryAction, orderAuthMethods, pathsToAuthorize, providerErrorMessage, type AcpAgent, type AcpAuthMethod, type ProviderBinary,
} from './providers';
import { filterAcpAgents } from './provider-list';
import { t } from './i18n';

const binary = (over: Partial<ProviderBinary> = {}): ProviderBinary => ({
  name: 'agent', found: 'agent', resolved: '/usr/bin/agent', allowed: false, refused: null, ...over,
});
const agent = (over: Partial<AcpAgent> = {}): AcpAgent => ({
  id: 'a', name: 'A', version: '2', description: null, website: null, license: null,
  supported: true, reason: null, integrity: 'sha256', installed: null, ...over,
});

test('a binary asks for authorization only when it resolved, is allowed to be, and is not yet', () => {
  assert.equal(binaryAction(binary()), 'authorize');
  assert.equal(binaryAction(binary({ allowed: true })), 'ready');
  assert.equal(binaryAction(binary({ resolved: null })), 'install');
  assert.equal(binaryAction(binary({ refused: 'launcher' })), 'refused');
});

test('only resolved, non-refused, distinct paths are sent back for authorization', () => {
  assert.deepEqual(pathsToAuthorize([
    binary(), binary({ name: 'twin' }), binary({ name: 'gone', resolved: null }),
    binary({ name: 'sh', resolved: '/bin/sh', refused: 'launcher' }),
  ]), ['/usr/bin/agent']);
});

test('ACP row action: install, update, repair a tampered one, nothing when unsupported or current', () => {
  assert.equal(acpAction(agent()), 'install');
  assert.equal(acpAction(agent({ supported: false })), 'none');
  const installed = (state: 'ok' | 'tampered' | 'missing' | 'pending', updateAvailable: boolean) =>
    ({ version: '1', integrity: 'sha256' as const, updateAvailable, state, profileId: 'acp-a' });
  assert.equal(acpAction(agent({ installed: installed('ok', false) })), 'none');
  assert.equal(acpAction(agent({ installed: installed('ok', true) })), 'update');
  assert.equal(acpAction(agent({ installed: installed('tampered', false) })), 'repair');
  assert.equal(acpAction(agent({ installed: installed('missing', true), supported: false })), 'none');
});

test('ACP row action: an unverified install the registry now hashes is offered the verified build, before a plain update', () => {
  const installed = { version: '1.4.1', integrity: 'unverified' as const, updateAvailable: true, verifiedUpdate: true, state: 'ok' as const, profileId: 'acp-a' };
  assert.equal(acpAction(agent({ installed })), 'verify');
  assert.equal(acpAction(agent({ installed: { ...installed, verifiedUpdate: false } })), 'update');
  assert.equal(acpAction(agent({ installed: { ...installed, state: 'tampered' } })), 'repair', 'a repair comes first');
  assert.equal(acpAction(agent({ installed, supported: false })), 'none');
});

test('sign-in methods: the suggested one first, billed per token last', () => {
  const method = (id: string, over: Partial<AcpAuthMethod> = {}): AcpAuthMethod => ({
    id, name: id, description: null, kind: 'agent', billedPerToken: false, recommended: false, command: null, ...over,
  });
  const ordered = orderAuthMethods([method('key', { billedPerToken: true }), method('business'), method('google', { recommended: true })]);
  assert.deepEqual(ordered.map((m) => m.id), ['google', 'business', 'key']);
});

test('daemon codes map to sentences; an unknown one keeps the daemon message', () => {
  assert.match(providerErrorMessage(403, '', ''), /superadmin/);
  assert.match(providerErrorMessage(409, 'mismatch', 'x'), /changed/);
  assert.match(providerErrorMessage(502, 'inspect-failed', 'x'), /signs in/);
  // Only the daemon's words quote what the program printed (TODO #588).
  assert.equal(providerErrorMessage(409, 'binary-identity', 'printed "other 1.0"'), 'printed "other 1.0"');
  assert.equal(providerErrorMessage(500, 'weird', 'from the daemon'), 'from the daemon');
  assert.match(providerErrorMessage(500, '', ''), /HTTP 500/);
});

test('a refused catalogue install keeps the daemon reason after the sentence', () => {
  for (const code of ['archive', 'checksum', 'download-failed', 'command-missing', 'definition-refused']) {
    const sentence = t(`providersSettings.errors.${code}`);
    assert.equal(providerErrorMessage(502, code, 'the daemon says why'), `${sentence} (the daemon says why)`);
    assert.equal(providerErrorMessage(502, code, ''), sentence);
  }
  assert.equal(providerErrorMessage(409, 'already-installed', 'x'), t('providersSettings.errors.already-installed'));
});

test('a catalogue agent reads in one line: what runs here, what is offered, and the pastille it deserves', () => {
  const line = (over: Partial<AcpAgent>) => {
    const { tone, key, vars } = acpStateLine(agent(over));
    return [tone, t(key, vars)];
  };
  const installed = (over: Partial<NonNullable<AcpAgent['installed']>> = {}) =>
    ({ version: '1', integrity: 'sha256' as const, updateAvailable: false, state: 'ok' as const, profileId: 'acp-a', ...over });
  assert.deepEqual(line({}), ['ready', 'Version 2, checksum verified']);
  assert.deepEqual(line({ integrity: 'none' }), ['action', 'Version 2, no published checksum']);
  assert.deepEqual(line({ supported: false, reason: 'no build for this OS' }), ['off', 'Not available on this computer: no build for this OS']);
  assert.deepEqual(line({ installed: installed() }), ['ready', 'Installed 1, checksum verified']);
  assert.deepEqual(line({ installed: installed({ integrity: 'unverified' }) }), ['ready', 'Installed 1, no published checksum']);
  assert.deepEqual(line({ installed: installed({ updateAvailable: true }) }), ['action', 'Installed 1 · verified 2 available']);
  assert.deepEqual(line({ integrity: 'none', installed: installed({ updateAvailable: true }) }),
    ['action', 'Installed 1 · 2 available, without a published checksum']);
  assert.deepEqual(line({ installed: installed({ integrity: 'unverified', updateAvailable: true, verifiedUpdate: true }) }),
    ['action', 'Installed 1 without a published checksum · verified 2 available to replace it']);
  assert.deepEqual(line({ integrity: 'none', installed: installed({ integrity: 'unverified', updateAvailable: true }) }),
    ['action', 'Installed 1 without a published checksum · 2 available, without one either']);
  assert.deepEqual(line({ installed: installed({ state: 'tampered' }) }), ['blocked', 'Installed 1: its files changed, so Timon does not use it']);
  assert.deepEqual(line({ installed: installed({ state: 'missing' }) }), ['blocked', 'Installed 1: its files are missing']);
  assert.deepEqual(line({ installed: installed({ state: 'pending' }) }), ['off', 'Checking 1…']);
});

test('the catalogue search reads the name, the id and the description, case and accents ignored', () => {
  const agents = [agent({ id: 'gemini', name: 'Gemini CLI' }), agent({ id: 'oc', name: 'OpenCode', description: 'Agent de codage ouvert' })];
  assert.deepEqual(filterAcpAgents(agents, '').map((a) => a.id), ['gemini', 'oc']);
  assert.deepEqual(filterAcpAgents(agents, '  GEMINI ').map((a) => a.id), ['gemini']);
  assert.deepEqual(filterAcpAgents(agents, 'oc').map((a) => a.id), ['oc']);
  assert.deepEqual(filterAcpAgents(agents, 'codáge').map((a) => a.id), ['oc']);
  assert.deepEqual(filterAcpAgents(agents, 'nothing'), []);
});
