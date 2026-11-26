import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('PATCH', `/api/backends/manage/${encodeURIComponent(params.id)}`, await req.json().catch(() => ({})));
}
