/**
 * The window's Content-Security-Policy, wired into the app's HTTP server
 * (`server.ts`): every response carries it, documents and API alike, so a
 * same-origin URL started as a worker or framed is held to the same egress as
 * the page (`lib/content-security-policy.ts`).
 *
 * The declared hosts come from the LOCAL daemon's `/api/plugins`, read with
 * the daemon token: a browser half always loads from this computer's copy,
 * a remote machine's plugin included (`plugin-host/remote-plugins.ts`).
 *
 * The script nonce is born here rather than in `proxy.ts`: this is where
 * the one policy of the response is composed, for every path, and the
 * proxy skips `/api/` and the static files. The policy also replaces the
 * request's own `content-security-policy` header, which is where Next reads
 * the nonce: one a client sent cannot reach the render.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CSP_HEADER,
  contentSecurityPolicy,
  createEgressSource,
  createScriptNonce,
  enforceContentSecurityPolicy,
  inlineScriptsAllowed,
  wantsFreshPolicy,
  type EgressSource,
} from '../content-security-policy';
import { localTarget } from '../machines/target';
import { orchestratorAuthHeaders } from '../orchestrator';

const LOAD_TIMEOUT_MS = 1_500;

async function loadDaemonPlugins(): Promise<unknown> {
  const res = await fetch(`${localTarget().url}/api/plugins`, {
    headers: orchestratorAuthHeaders(),
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function createWindowPolicy(opts: { dev: boolean; source?: EgressSource }): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let warned = false;
  const source = opts.source ?? createEgressSource({
    load: loadDaemonPlugins,
    onError: (error) => {
      if (warned) return;
      warned = true;
      console.warn(`[timon-app] plugin egress hosts unavailable, window held to its own origin: ${(error as Error).message}`);
    },
  });
  return async (req, res) => {
    if (wantsFreshPolicy(req.method, req.headers)) await source.refresh();
    const host = typeof req.headers.host === 'string' ? req.headers.host : null;
    const inlineScripts = inlineScriptsAllowed(req.url);
    const policy = contentSecurityPolicy({
      egressHosts: source.hosts(),
      dev: opts.dev,
      selfHost: host,
      nonce: inlineScripts ? null : createScriptNonce(),
      inlineScripts,
    });
    req.headers[CSP_HEADER.toLowerCase()] = policy;
    // Next falls back to it when the other is missing: never the client's.
    delete req.headers['content-security-policy-report-only'];
    enforceContentSecurityPolicy(res, policy);
  };
}
