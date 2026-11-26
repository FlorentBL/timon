import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A person answers the "Allow for this agent" card of a fence refusal. Browser session only: the daemon refuses any token. */
export async function POST(
  req: Request,
  props: { params: Promise<{ id: string; refusalId: string }> }
): Promise<Response> {
  const params = await props.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/fence-grants/${encodeURIComponent(params.refusalId)}`, body);
}
