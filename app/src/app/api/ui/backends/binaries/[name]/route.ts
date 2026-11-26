import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PUT(req: Request, props: { params: Promise<{ name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('PUT', `/api/host/binaries/${encodeURIComponent(params.name)}`, await req.json().catch(() => ({})));
}
export async function DELETE(_req: Request, props: { params: Promise<{ name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', `/api/host/binaries/${encodeURIComponent(params.name)}`);
}
