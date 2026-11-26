/**
 * The program a mission launch is about to start, judged against the plugin
 * policy (`docs/SECURITY.md` § 6.4.1, `docs/PROVIDERS-SDK.md` § 12 question 4).
 *
 * `ctx.host.exec` and `registerProvider` already refuse the subscription CLIs to a
 * plugin (`plugins/policy.ts`), but the process a MISSION runs is started by the daemon from whatever
 * the dialect's `buildSpawn` returned — a plugin's code chooses it at launch, not
 * only at registration. So the launch is held to the same lists:
 *
 *   - `core`: the product's own dialects, unchanged;
 *   - `official` (a provider shipped in the release): a subscription CLI only when
 *     the provider declared that program (`declares.binary`, which the manifest's
 *     `provider.binaries` authorized) — the exemption is for the program it names
 *     and nothing broader. A generic launcher, `timon`, a git credential helper:
 *     never, for anyone;
 *   - `third-party`: none of those, whatever its manifest declares.
 *
 * The operator's allowlist (`pluginPolicy.exec.allow`) is asked by
 * `assertLaunchAuthorized`, below, for a third-party backend only. The name-based
 * limits of `plugins/policy.ts` apply here: a renamed copy of `claude` is not caught.
 */
import { statSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import { config } from '../config/load.js';
import {
  binKey, canonicalExecutable, canonicalPath, execDeniedReason, isSubscriptionCli, PluginPolicyError, resolveExecutable, samePath,
} from '../plugins/policy.js';
import { backendTrust, dialectDeclarations, isOfficialDialect, profileDeclarations, registeredBackendOwners, activeProfiles } from './registry.js';
import { baseBackendId } from './instance-id.js';
import { clearLaunchCard, raiseLaunchCard } from './launch-card.js';
import { launchProvenance } from './launch-provenance.js';
import { declaredBinaries } from '../host/declared-binaries.js';
import { npmNativeBehind } from '../host/binary-path.js';
import { BinaryIdentityError } from './binary-identity.js';

/** The plugin that answers for backend `backend`'s code, for the refusal. */
function ownerOf(backend: string): string {
  const dialect = activeProfiles().find((entry) => entry.profile.id === backend)?.profile.dialect;
  return (dialect ? registeredBackendOwners().dialects[dialect] : undefined)
    ?? registeredBackendOwners().profiles[baseBackendId(backend)] ?? 'unknown';
}


export function assertLaunchBinary(backend: string, cmd: string): void {
  const trust = backendTrust(backend);
  if (trust === 'core') return;
  const declared = (profileDeclarations(backend)?.binary?.names ?? []).map(binKey);
  const owner = ownerOf(backend);
  // The program as named, and what the name resolves to: an alias that points at `claude` is still `claude`.
  const resolved = resolveExecutable(cmd);
  for (const target of resolved && resolved !== cmd ? [cmd, resolved] : [cmd]) {
    const denied = execDeniedReason(target);
    if (!denied) continue;
    const key = binKey(target);
    if (trust === 'official' && isSubscriptionCli(key) && declared.includes(key)) continue;
    throw new PluginPolicyError(owner, 'host:exec', `backend \`${backend}\` launches \`${key}\`: ${denied}`
      + (trust === 'official' ? ' (an official provider may launch the subscription CLI it declares, nothing else)' : ''));
  }
}

/**
 * The files a third-party backend's launch may start, links followed, read LIVE at every launch — a
 * first spawn, a resume, a per-turn respawn — so a withdrawn authorization holds from the next one:
 *  - an absolute entry of `pluginPolicy.exec.allow` names THAT file. An authorization writes the file a
 *    link leads to (`exec-grants.ts`); an entry that is itself a link names no program, and a link
 *    retargeted after the authorization leads to another file: both need the operator to authorize again;
 *  - a bare-name entry keeps its meaning, "what the host resolves this name to", and is compared as the
 *    file it resolves to now: `/elsewhere/opencode` is not `opencode` because its basename is;
 *  - a third party's profile that sets no command of its own on an OFFICIAL dialect runs that dialect's
 *    program: the files its declared names resolve to (the code that chose it is the release's);
 *  - an authorized npm launcher also authorizes the native build it would start itself (C1 `npmNative`):
 *    the daemon now starts that build in its place, and an authorization given before must still hold.
 */
function authorizedPrograms(backend: string): string[] {
  const programs: string[] = [];
  for (const entry of config().pluginPolicy.exec.allow) {
    if (isAbsolute(entry)) {
      programs.push(entry);
      for (const declaration of declaredBinaries()) {
        const native = declaration.npmNative ? npmNativeBehind(declaration.names[0]!, entry) : null;
        if (native) programs.push(canonicalPath(native.file));
      }
    } else {
      const file = canonicalExecutable(entry);
      if (file) programs.push(file);
    }
  }
  const resolved = activeProfiles().find((entry) => entry.profile.id === backend);
  if (resolved && !resolved.profile.cmd && isOfficialDialect(resolved.profile.dialect, resolved.dialect)) {
    const dialect = resolved.dialect;
    const names = [
      ...('defaultCmd' in dialect && typeof dialect.defaultCmd === 'string' ? [dialect.defaultCmd] : []),
      ...(dialectDeclarations(resolved.profile.dialect)?.binary?.names ?? []),
    ];
    for (const name of names) {
      const file = canonicalExecutable(name);
      if (file) programs.push(file);
    }
  }
  return programs;
}

/**
 * What a launch checked, pinned to the file itself (a third party's program, or a product program whose
 * identity is checked): the path the spawn starts, the file it led to (links followed) and that file's
 * identity on disk (device and inode; the file index on NTFS).
 * The check and the spawn are not one system call: the provider's identity check runs in between
 * (`binary-identity.ts`, it starts the program), so a link retargeted or a file renamed over the checked
 * one during that time would be started unchecked. `assertLaunchPinned` is the last thing before the
 * spawn. Device and inode alone are not enough (TODO #1212): ext4 hands a freed inode to the next file
 * created, so a path replaced twice can lead to another file under the checked identity. Size,
 * modification and change times are pinned too, in nanoseconds. The change time is the one a writer
 * cannot set back (`utimes` moves it), so on POSIX a rewrite in place is caught as well. No content
 * hash (decision 3-B, option C set aside).
 */
export type LaunchPin = {
  readonly backend: string;
  readonly owner: string;
  /** The path the spawn starts (`SpawnResult.cmd`). */
  readonly program: string;
  /** The file it led to when checked. */
  readonly file: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  /**
   * The file was held to what the operator authorized (a third-party backend): a refusal raises the card
   * that leads back to that authorization. A product backend's pin only holds the spawn to the file its
   * identity check asked (`pinIdentifiedProgram`): there is nothing for the operator to authorize.
   */
  readonly authorized: boolean;
};

type FileIdentity = Pick<LaunchPin, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>;

function fileIdentity(file: string): FileIdentity | null {
  try {
    const st = statSync(file, { bigint: true });
    return st.isFile() ? { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs } : null;
  } catch {
    return null;
  }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** A refused third-party launch: the error the mission reports, and the card that leads to the fix. */
function refuse(owner: string, backend: string, message: string): PluginPolicyError {
  const error = new PluginPolicyError(owner, 'host:exec', message);
  raiseLaunchCard(owner, backend, `${message.charAt(0).toUpperCase()}${message.slice(1).replace(/\.?$/, '.')}`);
  return error;
}

/**
 * Before a THIRD-PARTY backend's launch starts `cmd` (TODO #531, decision 3-B): the file it really
 * launches — resolved on this host, links followed — must be one the operator authorized
 * (`authorizedPrograms`) or, for a program the daemon installed itself, exactly that program
 * (`launch-provenance.ts`, typed, never a pattern on a folder). What is compared is the final path, not
 * a basename. Returns the resolved path the spawn must use, so a search path that moves between this
 * check and the spawn cannot land on another file, and the pin `assertLaunchPinned` holds the spawn to.
 * A product backend (core or official) passes untouched: its exemptions are `assertLaunchBinary`'s.
 * A refusal raises an `action_required` card (`launch-card.ts`, TODO #598).
 */
export function assertLaunchAuthorized(backend: string, cmd: string): { program: string; pin: LaunchPin | null } {
  if (backendTrust(backend) !== 'third-party') return { program: cmd, pin: null };
  const owner = ownerOf(backend);
  const resolved = resolveExecutable(cmd);
  if (!resolved) {
    throw refuse(owner, backend, `backend \`${backend}\` launches \`${cmd}\`, which is no program on this host: nothing to compare with what was authorized`);
  }
  const launched = canonicalPath(resolved);
  // The name was judged by `assertLaunchBinary`; the file a link leads to is judged here.
  const denied = execDeniedReason(launched);
  if (denied) throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`: ${denied}`);
  const provenance = launchProvenance(baseBackendId(backend));
  if (provenance) {
    if (!samePath(canonicalPath(provenance.path), launched)) {
      throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`, not the program the daemon installed for it `
        + `(${provenance.source} ${provenance.version}: \`${provenance.path}\`)`);
    }
  } else if (!authorizedPrograms(backend).some((program) => samePath(program, launched))) {
    throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`, which \`pluginPolicy.exec.allow\` does not authorize: `
      + 'the program moved, a link now leads elsewhere, or the authorization was withdrawn. '
      + 'If this is the program you expect, authorize it again from the provider\'s page (Settings › AI models › Backends).');
  }
  const identity = fileIdentity(launched);
  if (!identity) throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`, which is not a regular file`);
  clearLaunchCard(owner);
  return { program: resolved, pin: { backend, owner, program: resolved, file: launched, authorized: true, ...identity } };
}

/**
 * Before the identity check of a PRODUCT backend's program (`declares.binary.identity`, TODO #1201): that
 * check starts the file `cmd` resolves to and asks it what it is, but the spawn resolved the name again
 * afterwards, so a program replaced in between (a pinned path rewritten, a CLI updating itself, another
 * install winning the name) was started on the strength of another file's answer. Codex and the profiles
 * on its dialect (Ollama Cloud) are held to the same pin as a third party's program: the spawn starts the
 * path that was checked, and `assertLaunchPinned` refuses it if it no longer leads to that very file.
 *
 * Nothing changes where there is no identity to check, nor for a third party, already pinned by
 * `assertLaunchAuthorized`. A `cmd` the host does not resolve, or that leads to no regular file, is left
 * as it was: the identity check skips or refuses it, and a spawn of nothing ends on its `missing` notice.
 */
export function pinIdentifiedProgram(backend: string, cmd: string): { program: string; pin: LaunchPin | null } {
  if (backendTrust(backend) === 'third-party' || !profileDeclarations(backend)?.binary?.identity) return { program: cmd, pin: null };
  const resolved = resolveExecutable(cmd);
  if (!resolved) return { program: cmd, pin: null };
  const file = canonicalPath(resolved);
  const identity = fileIdentity(file);
  if (!identity) return { program: cmd, pin: null };
  return { program: resolved, pin: { backend, owner: ownerOf(backend), program: resolved, file, authorized: false, ...identity } };
}

/**
 * The spawn is about to start `pin.program`: it must still lead to the very file that was checked, by
 * path and by identity. Synchronous, and called with nothing awaited between it and the spawn. What it
 * cannot see is what happens after it — between this call and the `execve` of the launcher chain — and,
 * where the change time is not kept, a file rewritten in place to the same size and times
 * (`docs/SECURITY.md` § 6.4.1).
 */
export function assertLaunchPinned(pin: LaunchPin): void {
  const file = canonicalPath(pin.program);
  const identity = fileIdentity(file);
  if (samePath(file, pin.file) && identity && sameIdentity(identity, pin)) return;
  if (!pin.authorized) {
    // The identity refusal's rules: the program by its own name, never its full path (`binary-identity.ts`).
    throw new BinaryIdentityError(`backend \`${pin.backend}\` was about to launch \`${win32.basename(pin.program)}\`, which no longer is `
      + 'the file checked for this launch: it was replaced, or a link moved, between its identity check and the launch. '
      + 'The next launch checks the program as it is then.');
  }
  throw refuse(pin.owner, pin.backend, `backend \`${pin.backend}\` was about to launch \`${pin.program}\`, which no longer is the file `
    + `checked for this launch (\`${pin.file}\`): it was replaced, or a link moved, between the check and the launch`);
}
