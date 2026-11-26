import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/agents/${encodeURIComponent(params.id)}/send`, body);
}
