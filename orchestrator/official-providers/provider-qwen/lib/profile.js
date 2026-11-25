// @ts-check
/**
 * The profile of Qwen Code (`qwen --acp`). It holds its own sign-in (`qwen`, then `/auth`), kept in
 * `~/.qwen` with its settings and its sessions: the folder the manifest declares, writable by a Qwen
 * mission and masked from the others. Timon stores no key and passes none of its variables.
 *
 * `timon.provider.backends` of the manifest: the vendor's own installers (README of QwenLM/qwen-code,
 * checked 25/11/2026), `install-qwen-standalone.sh` and `.ps1`. They unpack a standalone build with its
 * own Node.js when one is published, and fall back on npm otherwise. The POSIX one writes
 * `~/.local/bin/qwen`, which every binary already gets; the Windows one writes
 * `%LOCALAPPDATA%\qwen-code\bin\qwen.cmd`, hence `searchDirs`. Qwen Code is also published on npm as
 * `@qwen-code/qwen-code` (Apache-2.0, Node.js 22 or newer): `install`, and where the newest version is
 * read; `npm install -g` writes a `qwen.cmd` shim on Windows, which the binary resolution finds.
 * Homebrew's `qwen-code` lands in a folder every binary already gets.
 *
 * The CLI changes fast (its sign-in was reworked, `qwen auth` removed): what this plugin relies on
 * was verified on 0.28.4 (`agent.js`), the oldest version it accepts (`minCliVersion`), and
 * `updateCheck.supportedMajor: 0` keeps Install and Update off a 1.x nobody has driven yet.
 */
import { manifestBackend } from './manifest.js';

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const QWEN_PROFILE = {
  id: 'qwen',
  dialect: 'qwen',
  label: 'Qwen Code',
  vendor: 'Qwen',
  brand: 'qwen',
  requiredBinary: manifestBackend('qwen').binary?.names[0],
  minCliVersion: '0.28.4',
  subscription: {
    note: 'Calls go through the account Qwen Code itself is signed in to (`/auth` in `qwen` on the host: '
      + 'Qwen OAuth with a chat.qwen.ai plan, or a Coding Plan key). A standard API key set up there is '
      + 'billed by the token. Qwen Code asks Timon before an edit or a command: the request appears as an '
      + 'Allow / Deny card.',
  },
  // No model is named: the list depends on the sign-in (Qwen OAuth, Coding Plan, a key) and comes
  // from the agent (`session/new`). An empty field means "the agent's own default".
  defaultModel: null,
  models: [],
};
