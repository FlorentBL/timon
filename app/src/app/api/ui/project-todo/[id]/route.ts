import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', `/api/project-todo/${encodeURIComponent(params.id)}`, body);
}

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', `/api/project-todo/${encodeURIComponent(params.id)}`);
}
