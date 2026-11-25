/**
 * The checks `timon doctor` calls blocking, and the support report's
 * findings, read from one set of facts (TIM-0162).
 *
 * The report said "Findings: none detected" right under a doctor that said
 * "BLOCKING node not found": the doctor resolved its binaries itself and the
 * report never looked at what the doctor concluded. Now the doctor builds its
 * blockers with `missingRequiredBinaries` and reports the terminal; the report
 * turns the doctor's own answer into findings (`blockingFindings`) and, when
 * no doctor answers, computes the same facts here (`localBlockingFacts`).
 *
 * Never imports the database: the desktop's diagnostic runner loads this
 * module while an update waits for approval (I7 of the packaged-OS audit).
 */
import { z } from 'zod';
import { findExecutableBinary, resolvePinnedBinary } from './binary-path.js';
import { nodePtyStatus } from '../terminal-host/pty.js';

export type Finding = { id: string; text: string };

/** Binaries without which the doctor says Timon cannot work at all. */
export const REQUIRED_BINARIES: readonly string[] = ['node'];

/** A binary as the host adapter resolves it: the pin of `host.binaries`, then the search. */
export function resolveConfiguredBinary(name: string, pins: Record<string, string | null>): string | null {
  const pin = pins[name];
  return typeof pin === 'string' && pin ? resolvePinnedBinary(name, pin) : findExecutableBinary(name);
}

/** The doctor's blocker for each required binary `found` does not resolve, in its exact words. */
export function missingRequiredBinaries(found: (name: string) => string | null): string[] {
  return REQUIRED_BINARIES.filter((name) => !found(name)).map((name) => `${name} not found`);
}

export type TerminalFacts = { available: boolean; reason: string | null };

export type BlockingFacts = {
  /** The doctor's `blockers`, verbatim. */
  blockers: string[];
  /** Whether the built-in terminal can start; null when nobody could tell (a daemon older than the field). */
  terminal: TerminalFacts | null;
  /** The doctor's mission isolation; null when it was not measured (no doctor answered). */
  isolation: { configured: 'auto' | 'enforce' | 'off'; enforced: boolean; launch: 'fenced' | 'unfenced' | 'refused'; message: string } | null;
  platform: NodeJS.Platform;
};

/** What a doctor report must hold for its facts to be read; anything else in it is ignored. */
const DoctorFactsSchema = z.object({
  platform: z.string(),
  blockers: z.array(z.string()),
  terminal: z.object({ available: z.boolean(), reason: z.string().nullable() }).optional(),
  missionIsolation: z.object({
    configured: z.enum(['auto', 'enforce', 'off']),
    enforced: z.boolean(),
    launch: z.enum(['fenced', 'unfenced', 'refused']),
    message: z.string(),
  }).optional(),
});

/** The facts of a doctor report (`diagnose()`, or the JSON of `/api/doctor`); null when it is not one. */
export function blockingFactsOf(report: unknown): BlockingFacts | null {
  const parsed = DoctorFactsSchema.safeParse(report);
  if (!parsed.success) return null;
  const { platform, blockers, terminal, missionIsolation } = parsed.data;
  return { platform: platform as NodeJS.Platform, blockers, terminal: terminal ?? null, isolation: missionIsolation ?? null };
}

/**
 * The same facts computed here, when no doctor answers (the daemon is down):
 * the required binaries resolved as the doctor resolves them, and the terminal
 * loaded as the daemon loads it. Isolation needs the host's fence, which only
 * the daemon measures.
 */
export function localBlockingFacts(
  pins: Record<string, string | null>,
  probe: { found?: (name: string) => string | null; terminal?: () => TerminalFacts } = {},
): BlockingFacts {
  const found = probe.found ?? ((name: string) => resolveConfiguredBinary(name, pins));
  return {
    blockers: missingRequiredBinaries(found),
    terminal: (probe.terminal ?? nodePtyStatus)(),
    isolation: null,
    platform: process.platform,
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'blocker';
}

/** One finding per blocker of the doctor, one for a terminal that cannot start, one for unfenced missions. */
export function blockingFindings(facts: BlockingFacts): Finding[] {
  const findings: Finding[] = facts.blockers.map((blocker) => ({
    id: `doctor-blocking-${slug(blocker)}`,
    text: `BLOCKING (timon doctor): ${blocker}.`,
  }));
  if (facts.terminal && !facts.terminal.available) {
    findings.push({
      id: 'terminal-unavailable',
      text: `The built-in terminal cannot start: its native module (node-pty) does not load here — ${facts.terminal.reason ?? 'no reason given'}.`
        + (facts.platform === 'linux' ? ' It needs glibc 2.28 or later: `ldd --version` prints the one of this system (TIM-0162).' : ''),
    });
  }
  // Windows has no fence yet: saying so on every Windows report is no finding.
  const iso = facts.isolation;
  if (iso && !iso.enforced && iso.configured !== 'off' && iso.launch === 'unfenced' && facts.platform !== 'win32') {
    findings.push({ id: 'missions-unfenced', text: `Mission isolation ${iso.message}` });
  }
  return findings;
}
