import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The daemon binds the flow to the session cookie this proxy forwards.
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/backends/accounts/${encodeURIComponent(params.id)}/login`);
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/backends/accounts/${encodeURIComponent(params.id)}/login`, await req.json().catch(() => ({})));
}

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', `/api/backends/accounts/${encodeURIComponent(params.id)}/login`);
}
