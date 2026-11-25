/**
 * The sentence rendered in the thread when the mission fence refused a path
 * (persisted `fence_refused` event, orchestrator/src/fence-refusal.ts).
 *
 * Pure, like `spawn-failure-notice.ts`. Before this notice a refusal of the fence
 * read as the CLI's own "Operation not permitted": nothing named the fence, the
 * path, or Settings › System › Security, where it is changed.
 */
import { t } from './i18n';
import { settingsPath } from './settings-path';

/** Payload of the `fence_refused` event: the daemon's `FenceRefusal`. Read defensively. */
export type FenceRefusedPayload = {
  path?: unknown;
  display?: unknown;
  access?: unknown;
  mechanism?: unknown;
  stage?: unknown;
  backend?: unknown;
  timonHome?: unknown;
  grantable?: unknown;
};

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** Payload of the `fence_suspected` event: a refusal that named no path, inside the fence. Read defensively. */
export type FenceSuspectedPayload = {
  said?: unknown;
  mechanism?: unknown;
  backend?: unknown;
};

/**
 * The sentence rendered when a fenced CLI stopped on "Operation not permitted"
 * without naming a path (codex's `os error 1`): nothing to check against the
 * policy, so the fence is named as the likely cause, with where it is changed.
 */
export function fenceSuspicionNotice(payload: FenceSuspectedPayload): string {
  return t('chatPage.fenceSuspected', {
    said: text(payload.said, 'Operation not permitted'),
    mechanism: payload.mechanism === 'seatbelt' ? 'seatbelt' : 'landlock',
    backend: text(payload.backend, '?'),
    settingsPath: settingsPath('system', 'security'),
  });
}

/** `launch`: the mission never started, and this notice is all its thread says. */
export function fenceRefusalEndsTurn(payload: FenceRefusedPayload): boolean {
  return payload.stage === 'launch';
}

export function fenceRefusalNotice(payload: FenceRefusedPayload): string {
  const vars = {
    path: text(payload.display, text(payload.path, '?')),
    access: payload.access === 'write' ? 'write' : 'read',
    mechanism: payload.mechanism === 'seatbelt' ? 'seatbelt' : 'landlock',
    backend: text(payload.backend, '?'),
    stage: payload.stage === 'launch' ? 'launch' : 'run',
    settingsPath: settingsPath('system', 'security'),
  };
  // The gesture depends on where the path is: a defect of Timon has a workaround,
  // a credential folder none, any other folder an exception.
  if (payload.timonHome === true) return t('chatPage.fenceRefusedTimonHome', vars);
  if (payload.grantable === true) return t('chatPage.fenceRefusedGrantable', vars);
  return t('chatPage.fenceRefusedProtected', vars);
}
