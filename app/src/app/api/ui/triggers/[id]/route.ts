import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/triggers/${encodeURIComponent(params.id)}`);
}

export async function PATCH(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', `/api/triggers/${encodeURIComponent(params.id)}`, body);
}

export async function DELETE(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', `/api/triggers/${encodeURIComponent(params.id)}`);
}
