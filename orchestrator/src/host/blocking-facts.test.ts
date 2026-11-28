import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REQUIRED_BINARIES, blockingFactsOf, blockingFindings, localBlockingFacts, missingRequiredBinaries, packagedStandIn, type BlockingFacts,
} from './blocking-facts.js';
import type { RuntimeFacts } from './bundled-node.js';
import { BINARIES } from '../doctor.js';
import { explainNodePtyFailure } from '../terminal-host/pty.js';

const healthy: BlockingFacts = { blockers: [], terminal: { available: true, reason: null }, isolation: null, platform: 'linux' };
const ids = (facts: BlockingFacts) => blockingFindings(facts).map((finding) => finding.id);

test('TIM-0162: the doctor requires the binaries the report checks, in the same words', () => {
  assert.deepEqual(BINARIES.filter((binary) => binary.required).map((binary) => binary.name), [...REQUIRED_BINARIES]);
  assert.deepEqual(missingRequiredBinaries(() => null), ['node not found']);
  assert.deepEqual(missingRequiredBinaries((name) => `/usr/bin/${name}`), []);
});

test('TIM-0162: a doctor blocker, a terminal that cannot start and unfenced missions are findings', () => {
  assert.deepEqual(ids(healthy), []);
  assert.deepEqual(ids({ ...healthy, blockers: ['node not found', 'no LLM backend installed (claude, codex)'] }), [
    'doctor-blocking-node-not-found', 'doctor-blocking-no-llm-backend-installed-claude-codex',
  ]);
  const terminal = blockingFindings({ ...healthy, terminal: { available: false, reason: "version `GLIBC_2.42' not found" } });
  assert.deepEqual(terminal.map((finding) => finding.id), ['terminal-unavailable']);
  assert.match(terminal[0]!.text, /GLIBC_2\.42.*ldd --version/);
  assert.doesNotMatch(blockingFindings({ ...healthy, platform: 'darwin', terminal: { available: false, reason: 'x' } })[0]!.text, /glibc/);
});

test('the fence is a finding only where missions could be fenced and are not', () => {
  const iso = (over: Partial<NonNullable<BlockingFacts['isolation']>>): BlockingFacts['isolation'] => ({
    configured: 'auto', enforced: false, launch: 'unfenced', message: 'NOT enforced — the launcher does not answer.', ...over,
  });
  const unfenced = blockingFindings({ ...healthy, isolation: iso({}) });
  assert.deepEqual(unfenced.map((finding) => finding.id), ['missions-unfenced']);
  assert.equal(unfenced[0]!.text, 'Mission isolation NOT enforced — the launcher does not answer.');
  assert.deepEqual(ids({ ...healthy, isolation: iso({ enforced: true, launch: 'fenced' }) }), []);
  assert.deepEqual(ids({ ...healthy, isolation: iso({ configured: 'off' }) }), [], 'turned off on purpose');
  assert.deepEqual(ids({ ...healthy, platform: 'win32', isolation: iso({}) }), [], 'no fence on Windows yet: no trap to name');
  // `enforce` without a fence is a doctor blocker already: one finding, not two.
  assert.deepEqual(ids({ ...healthy, blockers: ['missions refused'], isolation: iso({ configured: 'enforce', launch: 'refused' }) }), [
    'doctor-blocking-missions-refused',
  ]);
});

test('the facts of a doctor report, from this daemon or an older one', () => {
  assert.equal(blockingFactsOf(null), null);
  assert.equal(blockingFactsOf({ ok: true }), null, 'no blockers: not a doctor report');
  assert.deepEqual(blockingFactsOf({ platform: 'linux', blockers: ['node not found'], ok: false }), {
    platform: 'linux', blockers: ['node not found'], terminal: null, isolation: null,
  });
  const facts = blockingFactsOf({
    platform: 'darwin', blockers: [], terminal: { available: false, reason: 'gone' },
    missionIsolation: { configured: 'auto', enforced: true, launch: 'fenced', message: 'enforced (seatbelt)', gaps: [] },
  });
  assert.deepEqual(facts?.terminal, { available: false, reason: 'gone' });
  assert.equal(facts?.isolation?.enforced, true);
});

test('with no doctor, the report measures the same facts here', () => {
  const facts = localBlockingFacts({}, { found: () => null, terminal: () => ({ available: false, reason: 'no addon' }), runtime: SOURCE });
  assert.deepEqual(facts.blockers, ['node not found']);
  assert.deepEqual(facts.terminal, { available: false, reason: 'no addon' });
  assert.equal(facts.isolation, null, 'only the daemon measures the fence');
  assert.deepEqual(localBlockingFacts({}, { found: (name) => `/bin/${name}`, terminal: () => ({ available: true, reason: null }) }).blockers, []);
});

const SOURCE: RuntimeFacts = { execPath: '/usr/bin/node', versions: { node: '24.0.0' } as NodeJS.ProcessVersions, platform: 'linux' };
const PACKAGED: RuntimeFacts = { ...SOURCE, execPath: '/opt/Timon/resources/node/node' };

test('an installed package\'s own Node stands for a node the system lacks; a source checkout still needs one', () => {
  const terminal = () => ({ available: true, reason: null });
  // The recipe of 27/11/2026: a bare Ubuntu Server, the .deb installed, no nodejs package.
  assert.deepEqual(localBlockingFacts({}, { found: () => null, terminal, runtime: PACKAGED }).blockers, []);
  assert.deepEqual(localBlockingFacts({}, { found: () => null, terminal, runtime: SOURCE }).blockers, ['node not found']);
  assert.equal(packagedStandIn('node', false, PACKAGED), '/opt/Timon/resources/node/node');
  assert.equal(packagedStandIn('node', false, { ...SOURCE, execPath: 'C:\\Program Files\\Timon\\resources\\node\\node.exe', platform: 'win32' }),
    'C:\\Program Files\\Timon\\resources\\node\\node.exe');
  assert.equal(packagedStandIn('node', false, SOURCE), null);
  // Only node: the package ships no git, no backend.
  assert.equal(packagedStandIn('git', false, PACKAGED), null);
  // A pin names the Node to launch: a broken one stays a blocker.
  assert.equal(packagedStandIn('node', true, PACKAGED), null);
  assert.deepEqual(localBlockingFacts({ node: '/missing/node' }, { found: () => null, terminal, runtime: PACKAGED }).blockers, ['node not found']);
  // A system Node, when there is one, is still the one found.
  assert.deepEqual(localBlockingFacts({}, { found: (name) => `/usr/bin/${name}`, terminal, runtime: PACKAGED }).blockers, []);
});

test('TIM-0162: node-pty\'s "checked: … prebuilds" error gives way to the built addon\'s own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-pty-explain-'));
  try {
    const masked = new Error('Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64: Error: Cannot find module');
    assert.match(explainNodePtyFailure(dir, masked, () => ({})), /^Failed to load native module/, 'no addon on disk: the original error');
    assert.match(explainNodePtyFailure(null, masked), /^Failed to load native module/);
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
    writeFileSync(join(dir, 'build', 'Release', 'pty.node'), '');
    const glibc = explainNodePtyFailure(dir, masked, () => {
      throw new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.42' not found (required by pty.node)\nmore");
    });
    assert.equal(glibc, `${join(dir, 'build', 'Release', 'pty.node')}: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.42' not found (required by pty.node)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
