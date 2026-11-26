import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, props: { params: Promise<{ id: string; spanId: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/missions/${encodeURIComponent(params.id)}/spans/${encodeURIComponent(params.spanId)}`);
}
