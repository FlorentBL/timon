import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The mission's permission mode and the levels this account may pick. The
 *  session cookie is the only identity relayed: the daemon decides. */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/missions/${encodeURIComponent(params.id)}/permission-mode`);
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/missions/${encodeURIComponent(params.id)}/permission-mode`,
    body,
  );
}
