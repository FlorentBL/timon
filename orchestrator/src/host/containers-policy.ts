/**
 * When a daemon must start no container at all (TODO #1169).
 *
 * A witness daemon — started from a worktree on `TIMON_HOME=$(mktemp -d)`, or
 * by the test runner — still sees the machine's Docker. Left alone it ran
 * `docker compose up tts` against the development repository, the same
 * Compose project name as the real install: the two then fight over one
 * container. The answer is decided once, here, and the adapter simply does not
 * build its `containers` capability: every module gated on it (tts,
 * docker-supervision, the embedded browser, the post-merge rebuild) stands
 * down without knowing why.
 */
import { underTemporaryDir, type TemporaryHomeOptions } from './temporary-home.js';

/** Explicit opt-out, for a witness whose home is not under the temporary folder. */
export const NO_CONTAINERS_ENV = 'TIMON_NO_CONTAINERS';

export type ContainersSuppression = {
  reason: 'flag' | 'test-runner' | 'temporary-home';
  /** One line for the boot log, saying how to get containers back when it applies. */
  message: string;
};

export type ContainersPolicyInput = {
  env: NodeJS.ProcessEnv;
  home: string;
} & TemporaryHomeOptions;

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Why this daemon must not start containers, or `null` when it may. */
export function containersSuppression(input: ContainersPolicyInput): ContainersSuppression | null {
  if (truthy(input.env[NO_CONTAINERS_ENV])) {
    return { reason: 'flag', message: `containers disabled: ${NO_CONTAINERS_ENV} is set` };
  }
  // Same signal `paths.ts` refuses the real home on.
  const testContext = input.env.NODE_TEST_CONTEXT;
  if (typeof testContext === 'string' && testContext !== '') {
    return { reason: 'test-runner', message: 'containers disabled: running under the test runner' };
  }
  if (underTemporaryDir(input.home, input)) {
    return {
      reason: 'temporary-home',
      message: `containers disabled: TIMON_HOME (${input.home}) is inside the system temporary folder — `
        + 'a witness daemon must not touch the containers of the real installation',
    };
  }
  return null;
}
