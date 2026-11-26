import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The pasted code travels in the body, never in the URL.
export async function POST(
  req: Request,
  props: { params: Promise<{ backend: string; kind: string }> }
): Promise<Response> {
  const params = await props.params;
  if (params.kind !== 'login' && params.kind !== 'token') return Response.json({ error: 'not found' }, { status: 404 });
  return proxyJson('POST', `/api/backends/host-sign-in/${encodeURIComponent(params.backend)}/${params.kind}/code`, await req.json().catch(() => ({})));
}
