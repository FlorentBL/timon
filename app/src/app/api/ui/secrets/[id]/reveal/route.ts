import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Browser session only: the proxy forwards the cookie, never the daemon token. */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/secrets/${encodeURIComponent(params.id)}/reveal`, body);
}
