import { uiComputerBody, uiComputerUpstream } from '@/lib/computer-use';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Computer use, as the screen needs it: the state of the desktop control and
 * the human's stop / resume. Every other command (click, type…) is the agent's
 * and goes through its mission token, never through a browser request, so this
 * proxy only relays what the daemon opens to a signed-in person: those three,
 * and the setup of the machine (system permission prompts, restart).
 * The probe of an open window (`a11y_probe_app`) is the one command that takes a body, validated here.
 */
function refused(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function GET(_req: Request, props: { params: Promise<{ command: string }> }): Promise<Response> {
  const { command } = await props.params;
  const upstream = uiComputerUpstream('GET', command);
  return upstream ? proxyJson(upstream.method, upstream.path, {}) : refused();
}

export async function POST(req: Request, props: { params: Promise<{ command: string }> }): Promise<Response> {
  const { command } = await props.params;
  const upstream = uiComputerUpstream('POST', command);
  if (!upstream) return refused();
  // Only the probe carries a body, and only its window id is forwarded.
  const body = uiComputerBody(command, command === 'a11y_probe_app' ? await req.json().catch(() => null) : null);
  if (!body) return Response.json({ error: 'invalid_arguments' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  return proxyJson(upstream.method, upstream.path, body);
}
