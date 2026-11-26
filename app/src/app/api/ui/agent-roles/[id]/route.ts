import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The daemon exposes PUT (full replacement) on an agent role, not PATCH.
export async function PUT(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', `/api/agent-roles/${encodeURIComponent(params.id)}`, body);
}

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', `/api/agent-roles/${encodeURIComponent(params.id)}`);
}
