// @ts-check
/**
 * Qwen Code as a row of the daemon's ACP runtime (`docs/PROVIDERS-SDK.md` § 7.1, § 10.2): the
 * protocol (session driver, permissions through the Allow/Deny card and the classifier, the model
 * probe) is the daemon's, what Qwen Code needs beyond it is a field here. The program and the
 * sign-in folder are its entry of the manifest's `timon.provider.backends` (`manifest.js`).
 *
 * Verified against the real agent, Qwen Code 0.28.4 (the version `minCliVersion` pins in
 * `profile.js`), on a throwaway home and a local stand-in for the model endpoint:
 *  - `qwen --acp` speaks the protocol (`--experimental-acp` was its older name);
 *  - `initialize` announces one auth method, `openai` (an `OPENAI_API_KEY`, billed by the token), and
 *    nothing for Qwen OAuth or the Coding Plan: those are set up inside `qwen` itself, with `/auth`.
 *    Without a sign-in, `session/new` answers -32000 ("Use /auth to sign in or configure a model");
 *  - `session/new` lists the account's models (`models.availableModels`), hence the probe;
 *  - it opens a session in its own `auto` approval mode, where its own classifier decides what to
 *    run without asking, or in whatever mode `tools.approvalMode` of the user's `~/.qwen/settings.json`
 *    names (`yolo` runs every tool unasked). `--approval-mode default` wins over that setting, and in
 *    `default` every edit and every shell command comes to Timon as `session/request_permission`;
 *  - it also sends a request of its own, `craft/drainMidTurnQueue`, after a tool call: answered
 *    "method not found", the turn goes on.
 *
 * @typedef {import('@timon-ai/sdk/provider').AcpAgentSpec} AcpAgentSpec
 */
import { manifestBackend } from './manifest.js';

const QWEN = manifestBackend('qwen');

/**
 * The sign-in sentence. Never `qwen auth`: that subcommand was removed. `/auth` inside `qwen` offers
 * Qwen OAuth (a chat.qwen.ai plan) and the plans billed by the month (Coding Plan, Token Plan), and
 * also API keys billed by the token, which the person picks or not; Timon never stores any of them.
 */
export const QWEN_SIGN_IN = 'run `qwen` in a terminal on this machine, type `/auth` and sign in with Qwen OAuth or a Coding Plan key, then retry';

/** @type {AcpAgentSpec} */
export const QWEN_AGENT = Object.freeze({
  id: 'qwen',
  // `default` keeps every edit and command on Timon's card: Qwen Code's own `auto` and a `yolo`
  // setting of the user would otherwise decide them without asking.
  args: ['--acp', '--approval-mode', 'default'],
  permissionsByAgent: false,
  // Only `plan` is handed over: Qwen Code's `auto-edit` and `auto` decide on their own what Timon's
  // card and classifier decide for the other modes, which reach the card as requests.
  sessionModes: Object.freeze({ plan: 'plan' }),
  modelProbe: 'session-new',
  // No `authenticateWith`: the one method announced is the per-token API key.
  signIn: { byMethod: { openai: QWEN_SIGN_IN }, fallback: QWEN_SIGN_IN },
  binary: /** @type {NonNullable<typeof QWEN.binary>} */ (QWEN.binary),
  declares: { credentialDirs: QWEN.credentialDirs },
});
