import { uiComputerUpstream } from '@/lib/computer-use';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Computer use, as the screen needs it: the state of the desktop control and
 * the human's stop / resume. Every other command (click, type…) is the agent's
 * and goes through its mission token, never through a browser request, so this
 * proxy only relays the three the daemon opens to a signed-in person.
 */
function refused(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function GET(_req: Request, props: { params: Promise<{ command: string }> }): Promise<Response> {
  const { command } = await props.params;
  const upstream = uiComputerUpstream('GET', command);
  return upstream ? proxyJson(upstream.method, upstream.path, {}) : refused();
}

export async function POST(_req: Request, props: { params: Promise<{ command: string }> }): Promise<Response> {
  const { command } = await props.params;
  const upstream = uiComputerUpstream('POST', command);
  return upstream ? proxyJson(upstream.method, upstream.path, {}) : refused();
}
