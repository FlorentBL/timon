/**
 * The shape and the text of `timon doctor`'s fence coverage (`fence-coverage.ts`).
 * Pure, and free of the daemon's state: the CLI renders what the daemon's route
 * answered without loading the registry.
 */

export type FenceCoverageCheck = {
  /** The path as the user reads it (`~` for the home). */
  display: string;
  access: 'read' | 'write';
  /** `allowed`: a mission of this profile must reach it. `refused`: it must never. */
  expect: 'allowed' | 'refused';
  /** What the policy says (`fenceAccess`). */
  policy: 'allowed' | 'refused';
  /** What the kernel did under that policy; `skipped` when no witness ran. */
  kernel: 'allowed' | 'refused' | 'error' | 'skipped';
  /** Why the kernel could not answer, for `error`. */
  reason?: string;
  /** What the path is to the mission. */
  why: string;
};

/**
 * Whether the profile's real launch was built (`buildSpawn`) and how many paths of the Timon home it
 * named, each one among the checks; or why it could not be (a sign-in missing, a provider refusing):
 * then only the folders the fence grants a mission were checked. Absent from an older daemon.
 */
export type FenceCoverageLaunch = { built: true; paths: number } | { built: false; error: string };

export type FenceCoverageProfile = { profile: string; ok: boolean; checks: FenceCoverageCheck[]; error?: string; launch?: FenceCoverageLaunch };

export type FenceCoverageReport = {
  /** `checked`: the fence applies and each active profile was checked. `unfenced`: missions run without it here. */
  state: 'checked' | 'unfenced';
  mechanism: string | null;
  /** Whether the kernel was asked (`HostFence` launcher), or only the policy. */
  witness: boolean;
  /** Why missions are not fenced, for `unfenced`. */
  reason: string | null;
  profiles: FenceCoverageProfile[];
  /** Exceptions of the configuration that open nothing, with the reason. */
  exceptions: Array<{ path: string; reason: string }>;
};

/** A check that does not hold: the policy or the kernel disagrees with what the mission needs. */
export function failedCheck(check: FenceCoverageCheck): boolean {
  if (check.policy !== check.expect) return true;
  return check.kernel !== 'skipped' && check.kernel !== check.expect;
}

function describe(check: FenceCoverageCheck): string {
  const verb = check.access === 'read' ? 'read' : 'write';
  if (check.kernel === 'error') return `${check.display}: ${verb} not checked by the kernel (${check.reason ?? 'no answer'})`;
  const who = check.policy !== check.expect ? 'the policy' : 'the kernel';
  const got = check.policy !== check.expect ? check.policy : check.kernel;
  return check.expect === 'allowed'
    ? `${check.display}: ${verb} ${got} by ${who}, the mission needs it (${check.why})`
    : `${check.display}: ${verb} ${got} by ${who}, it must stay refused (${check.why})`;
}

/** Text rendering, a section of `timon doctor`. */
export function formatFenceCoverage(report: FenceCoverageReport | null, unavailable?: string): string {
  if (!report) return `Fence coverage: not checked — ${unavailable ?? 'the daemon does not answer'}.\n`;
  if (report.state === 'unfenced') return `Fence coverage: missions are not fenced here (${report.reason ?? 'no fence'}).\n`;
  const how = report.witness ? `${report.mechanism}, checked by the kernel` : `${report.mechanism}, policy only`;
  const width = Math.max(8, ...report.profiles.map((p) => p.profile.length));
  const lines = [`Fence coverage (${how}):`];
  for (const profile of report.profiles) {
    if (profile.error) {
      lines.push(`  ${profile.profile.padEnd(width)}  ✗ ${profile.error}`);
      continue;
    }
    const failed = profile.checks.filter(failedCheck);
    const launch = profile.launch?.built ? `, ${profile.launch.paths} named by its launch` : '';
    lines.push(`  ${profile.profile.padEnd(width)}  ${failed.length ? '✗' : '✓'} ${profile.checks.length} path(s)${launch}`);
    if (profile.launch && !profile.launch.built) {
      lines.push(`      launch not built (${profile.launch.error}): only the folders the fence grants were checked`);
    }
    for (const check of failed) lines.push(`      ${describe(check)}`);
  }
  for (const entry of report.exceptions) lines.push(`  exception ${entry.path} opens nothing: ${entry.reason}`);
  if (report.profiles.some((p) => !p.ok)) {
    lines.push('  A refused path a mission needs makes its CLI fail with "Operation not permitted": please report it.');
  }
  return `${lines.join('\n')}\n`;
}
