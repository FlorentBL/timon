import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binaryProblems, npmNativeProblems } from './provider-declarations.js';

test('npmNative: the declaration is held to plain segments, a package name and harmless variables', () => {
  const ok = { package: '@openai/codex', platformPackage: '@openai/codex-${target}', executable: { 'linux-x64': ['vendor', 'bin', 'codex'] }, extraPath: ['..', 'codex-path'], env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: '${packageRoot}' } };
  assert.deepEqual(npmNativeProblems(ok), []);
  const bad: unknown[] = [
    { ...ok, package: 'Not A Package' },
    { ...ok, platformPackage: '@openai/codex-linux' },
    { ...ok, executable: {} },
    { ...ok, executable: { 'linux-x64': ['..', 'codex'] } },
    { ...ok, executable: { 'linux-x64': ['vendor/bin', 'codex'] } },
    { ...ok, executable: { 'linux-ppc': ['codex'] } },
    { ...ok, extraPath: ['/usr/bin'] },
    { ...ok, env: { LD_PRELOAD: 'x.so' } },
    { ...ok, env: { PATH: 'x' } },
    { ...ok, env: { TIMON_HOME: 'x' } },
    { ...ok, env: { NODE_OPTIONS: '--require=x' } },
    { ...ok, env: { CODEX_X: '$(id)' } },
    { ...ok, env: { CODEX_X: '/etc/passwd' } },
    'codex',
  ];
  for (const value of bad) assert.notDeepEqual(npmNativeProblems(value), [], JSON.stringify(value));
  assert.match(binaryProblems({ names: ['codex'], npmNative: { package: 'x' } }).join('\n'), /npmNative\.executable/);
});
