import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The code travels in the body only: never in a URL, where logs would keep it.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/backends/accounts/${encodeURIComponent(params.id)}/login/code`, await req.json().catch(() => ({})));
}
