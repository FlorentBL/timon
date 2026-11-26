/**
 * The command a backend builds for a launch, held to the rules of its launch seal
 * (`launch-seal.ts`): the program goes through the plugin policy, no reference may
 * sit in the command line or the environment, and the stdin payload carries the
 * values in place of the references. Shared by a mission's launch (`agent.ts`) and
 * a one-shot prompt (`summary.ts`).
 */
import { assertLaunchIdentity } from './binary-identity.js';
import { assertLaunchAuthorized, assertLaunchBinary, assertLaunchPinned, pinIdentifiedProgram, type LaunchPin } from './launch-binary.js';
import { SealedArgvError, SealedEnvError, type LaunchSeal } from './launch-seal.js';
import type { Backend, BuildSpawnOpts, SpawnResult } from './types.js';

/**
 * The file each launch was checked against, held until its spawn (`assertSpawnPinned`): a third party's
 * program, and a product backend's whose identity is checked.
 */
const PINS = new WeakMap<SpawnResult, LaunchPin>();

export async function buildSealedSpawn(backend: Backend, spawnOpts: BuildSpawnOpts, seal: LaunchSeal | null): Promise<SpawnResult> {
  let built: SpawnResult = await backend.buildSpawn(spawnOpts);
  // The program is chosen by the dialect's code at launch: held to the plugin policy before anything starts.
  assertLaunchBinary(backend.name, built.cmd);
  // A third party's program is the file the operator authorized, checked at EVERY launch (a resume, a
  // per-turn respawn): the spawn then starts the very path that was checked.
  // A product backend's program is pinned too when its identity is checked: the file that answers the
  // check below is the one the spawn starts (TODO #1201).
  const authorized = assertLaunchAuthorized(backend.name, built.cmd);
  const { program, pin } = authorized.pin ? authorized : pinIdentifiedProgram(backend.name, built.cmd);
  if (program !== built.cmd) built = { ...built, cmd: program };
  // The identity check below STARTS the program: it must be the file just checked.
  if (pin) assertLaunchPinned(pin);
  // A name is not an identity: the provider's declared self-description, checked before the program runs.
  await assertLaunchIdentity(backend.name, built.cmd);
  if (seal) {
    // Neither the command line (any account reads the process list) nor the environment (every child of
    // the CLI inherits it, the shell the model drives included) is a place for a secret: a reference
    // found there is a mistake to correct, not to paper over.
    if ([built.cmd, ...built.args].some((arg) => seal.has(arg))) throw new SealedArgvError(backend.name);
    if (Object.values(built.env ?? {}).some((value) => seal.has(value))) throw new SealedEnvError(backend.name);
  }
  // Swapped here, before `missionEnv`: a reference in the stdin payload becomes the value, written to the
  // process's own memory like the session's pipe — not inherited by anything it starts.
  const spec: SpawnResult = seal && built.initialStdin !== null
    ? { ...built, initialStdin: seal.swap(built.initialStdin) }
    : built;
  if (pin) PINS.set(spec, pin);
  return spec;
}

/**
 * The last thing before the spawn of a spec `buildSealedSpawn` returned, with nothing awaited between
 * the two: the program still leads to the file checked for this launch (TODO #598, #1201). A product
 * backend's spec whose program has no identity to check carries no pin and passes.
 */
export function assertSpawnPinned(spec: SpawnResult): void {
  const pin = PINS.get(spec);
  if (pin) assertLaunchPinned(pin);
}
