import { uiComputerJournalPath } from '@/lib/computer-use';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The action journal of an agent's computer use, read by the signed-in person.
 * Only `agent` and `limit` are forwarded; the daemon refuses anything but a
 * person's session, so an agent token never reads its own journal.
 */
export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const path = uiComputerJournalPath(params.get('agent') ?? '', Number(params.get('limit') ?? 50));
  if (!path) return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  return proxyJson('GET', path);
}
