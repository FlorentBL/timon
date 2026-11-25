/**
 * #1102, security review, iteration 4: when the host retains no `node` (none on
 * the machine, and the daemon's runtime fails its check), a CLI whose line is
 * `#!/usr/bin/env node` must not start through that line. It would run the
 * first `node` of the PATH the mission sets, which the mission can choose.
 * Asserted here at the launch: the mission is refused before any process, with
 * an error naming the CLI and no path, and a fake `node` put first on that PATH
 * never runs.
 *
 * Fake runtime check, stand-in CLIs, throwaway TIMON_HOME.
 */
import '../tests/helpers/no-load-gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-no-node-test-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { db } = await import('./db.js');
import type { MissionRow } from './db.js';
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
const stubs = await stubCliBinaries('claude');
await mountOfficialProviders();
const { getHost } = await import('./host/index.js');
const { setDaemonNodeCheckForTest, spawnAgent, upsertAgent } = await import('./agent.js');
const { NoTrustedNodeError } = await import('./host/launch-path.js');

/**
 * Lines GNU `env` does run through the first `node` of PATH (Linux hands
 * `env` the rest of the line as one word, which only `-S` splits): the control
 * below proves it, so each refusal of these is what keeps the fake node idle.
 */
const REACHING = [
  '#!/usr/bin/env -S VAR=x node',
  '#!/usr/bin/env -S -u NODE_OPTIONS node',
  '#!/usr/bin/env -S "node" --flag',
  '#!/usr/bin/env --split-string=node',
];

/**
 * The CLI's first line, one mission each: the standard one, then forms the
 * reader does not read with certainty (options, assignments, quotes, `-S`
 * spellings) and plain spellings that still name `node`.
 */
const LINES = [
  '#!/usr/bin/env node',
  '#!/usr/bin/env -i node',
  '#!/usr/bin/env -u NODE_OPTIONS node',
  '#!/usr/bin/env VAR=x node',
  '#!/usr/bin/env -S "node --flag"',
  "#!/usr/bin/env -S 'node'",
  '#!/usr/bin/env --split-string=node',
  '#!/usr/bin/env -Snode',
  '#!/usr/bin/env -- node',
  '#!/usr/bin/env  \t node',
  '#!/usr/bin/env nodejs',
  ...REACHING,
];

test('no trusted node: an `env node` CLI is refused and the fake node first on PATH never runs',
  { skip: process.platform === 'win32' && 'POSIX shebang' }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'timon-no-node-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const marker = join(root, 'fake-node-ran');
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    // A `node` that only leaves a trace: if anything ever executes it, the marker exists.
    writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    // The control: this fake node does run, and does leave its trace, when executed.
    execFileSync(join(fakeBin, 'node'));
    assert.ok(existsSync(marker), 'the fake node leaves its trace when it runs');
    rmSync(marker);

    // The CLI the launch resolves: an npm script whose line looks `node` up on PATH.
    writeFileSync(join(stubs, 'claude'), `${LINES[0]}\nprocess.exit(0);\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ''}`;
    const host = getHost();
    const originalBin = host.bin;
    const originalSpawn = host.spawn;
    let spawns = 0;
    // The machine has no node of its own, and the daemon's runtime fails its check.
    host.bin = ((name: string) => {
      if (name === 'node') throw new Error('node: not found');
      return originalBin(name);
    }) as typeof host.bin;
    host.spawn = ((...args: Parameters<typeof host.spawn>) => {
      spawns++;
      return originalSpawn(...args);
    }) as typeof host.spawn;
    setDaemonNodeCheckForTest(() => ({ node: null, problem: 'replaced' }));
    t.after(() => {
      host.bin = originalBin;
      host.spawn = originalSpawn;
      setDaemonNodeCheckForTest(null);
      process.env.PATH = previousPath;
    });

    const cwd = join(root, 'project');
    mkdirSync(cwd);
    upsertAgent({
      name: 'no-node',
      system_prompt: 'node witness — does nothing.',
      config: { backend: 'claude', cwd, skills: [], mcp_servers: [], memory_scope: 'NONE' },
    });

    let error: unknown = null;
    try {
      await spawnAgent('no-node', 'ping');
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof NoTrustedNodeError, `expected NoTrustedNodeError, got ${String(error)}`);
    assert.match(error.message, /^no trusted Node\.js to run claude/);
    assert.ok(!error.message.includes(stubs) && !error.message.includes(root), 'no path in the error');
    assert.equal(spawns, 0, 'no process is started');
    // Long enough for a process started anyway to have run its first line.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(marker), false, 'the fake node on the mission\'s PATH never ran');

    const [mission] = db.prepare(`SELECT * FROM missions WHERE agent_name = ?`).all('no-node') as MissionRow[];
    assert.ok(mission);
    assert.equal(mission.status, 'failed');
    assert.notEqual(mission.interrupted_reason, 'crash', 'a replay meets the same machine: no crash to replay');

    // #1102, iteration 5: every other `env` line naming `node`, or whose interpreter is not
    // certain, is refused the same way. Each is tried as its own mission against the same witness.
    await t.test('every unrecognised `env` line is refused too, and the fake node never runs', async () => {
      for (const line of LINES.slice(1)) {
        writeFileSync(join(stubs, 'claude'), `${line}\nprocess.exit(0);\n`, { mode: 0o755 });
        const before = spawns;
        let refused: unknown = null;
        try {
          await spawnAgent('no-node', 'ping');
        } catch (err) {
          refused = err;
        }
        assert.ok(refused instanceof NoTrustedNodeError, `${JSON.stringify(line)}: expected NoTrustedNodeError, got ${String(refused)}`);
        assert.equal(spawns, before, `${JSON.stringify(line)}: no process is started`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(existsSync(marker), false, `${JSON.stringify(line)}: the fake node on the mission's PATH never ran`);
      }
    });

    // The control: launched through its own line, with the mission's PATH, such a CLI does run the
    // fake node (GNU env), so the refusals above are what keeps it from running.
    await t.test('control: these lines do reach the fake node when left to `env`', { skip: process.platform !== 'linux' && 'GNU env' }, () => {
      const probe = join(root, 'probe');
      for (const line of REACHING) {
        writeFileSync(probe, `${line}\n`, { mode: 0o755 });
        execFileSync(probe, { env: { ...process.env, PATH: `${fakeBin}${delimiter}${previousPath ?? ''}` } });
        assert.ok(existsSync(marker), `${line}: runs the fake node`);
        rmSync(marker);
      }
    });
  });
