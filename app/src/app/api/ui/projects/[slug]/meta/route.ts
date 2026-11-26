import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, props: { params: Promise<{ slug: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/projects/${encodeURIComponent(params.slug)}/meta`);
}

export async function PUT(req: Request, props: { params: Promise<{ slug: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', `/api/projects/${encodeURIComponent(params.slug)}/meta`, body);
}
