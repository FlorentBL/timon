/**
 * A witness daemon starts no container (TODO #1169): the flag, the test
 * runner and a temporary home each take the `containers` capability away,
 * and a normal install keeps it.
 */
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-containers-policy-'));

const { TimonConfigSchema } = await import('../config/schema.js');
const { createGenericHost } = await import('./generic.js');
const { containersSuppression, NO_CONTAINERS_ENV } = await import('./containers-policy.js');

const TMP = resolve('/scratch/tmp');
const REAL_HOME = resolve('/home/someone/.timon');
const opts = { tmp: TMP, platform: 'linux' as const, realpath: () => null };

test('a normal home outside the test runner keeps its containers', () => {
  assert.equal(containersSuppression({ env: {}, home: REAL_HOME, ...opts }), null);
  assert.equal(containersSuppression({ env: { [NO_CONTAINERS_ENV]: '0' }, home: REAL_HOME, ...opts }), null);
  assert.equal(containersSuppression({ env: { [NO_CONTAINERS_ENV]: '' }, home: REAL_HOME, ...opts }), null);
  assert.equal(containersSuppression({ env: { NODE_TEST_CONTEXT: '' }, home: REAL_HOME, ...opts }), null);
});

test('TIMON_NO_CONTAINERS takes containers away, whatever the home', () => {
  for (const value of ['1', 'true', 'YES', ' on ']) {
    const out = containersSuppression({ env: { [NO_CONTAINERS_ENV]: value }, home: REAL_HOME, ...opts });
    assert.equal(out?.reason, 'flag', value);
    assert.match(out?.message ?? '', /TIMON_NO_CONTAINERS/);
  }
});

test('the test runner takes containers away', () => {
  const out = containersSuppression({ env: { NODE_TEST_CONTEXT: 'child-v8' }, home: REAL_HOME, ...opts });
  assert.equal(out?.reason, 'test-runner');
});

test('a home inside the temporary folder takes containers away', () => {
  const out = containersSuppression({ env: {}, home: join(TMP, 'tmp.Ab12'), ...opts });
  assert.equal(out?.reason, 'temporary-home');
  assert.ok(out?.message.includes(join(TMP, 'tmp.Ab12')), 'the log names the home');
});

test('a temporary home reached through a link is still temporary (macOS /var → /private/var)', () => {
  const realTmp = resolve('/private/var/folders/x/T');
  const out = containersSuppression({
    env: {},
    home: resolve('/var/folders/x/T/tmp.home'),
    tmp: realTmp,
    platform: 'darwin',
    realpath: (path) => (path.startsWith(resolve('/var/')) ? resolve('/private', path.slice(1)) : null),
  });
  assert.equal(out?.reason, 'temporary-home');
});

// A docker that would answer `docker info` with success: without the policy,
// the adapter would build its `containers` capability on it.
test('the generic adapter builds no containers capability under the test runner', { skip: process.platform === 'win32' && 'a shell script stands for docker' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-fake-docker-'));
  const docker = join(dir, 'docker');
  writeFileSync(docker, '#!/bin/sh\nexit 0\n');
  chmodSync(docker, 0o755);
  const host = createGenericHost(TimonConfigSchema.parse({ host: { docker: 'auto' } }), {}, () => ({ docker }));
  assert.equal(host.containers, undefined);
  assert.ok(!host.capabilities().includes('containers'));
});
