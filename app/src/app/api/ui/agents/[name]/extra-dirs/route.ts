import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The agent's extra folders have their own door on the daemon: the config
// route strips them, and only a person (or agents:privileged-config) writes them.
const path = (name: string): string => `/api/agents/${encodeURIComponent(name)}/extra-dirs`;

export async function GET(_req: Request, props: { params: Promise<{ name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', path(params.name));
}

export async function PUT(req: Request, props: { params: Promise<{ name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('PUT', path(params.name), await req.json().catch(() => ({})));
}

export async function POST(req: Request, props: { params: Promise<{ name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', path(params.name), await req.json().catch(() => ({})));
}

export async function DELETE(req: Request, props: { params: Promise<{ name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', path(params.name), await req.json().catch(() => ({})));
}
