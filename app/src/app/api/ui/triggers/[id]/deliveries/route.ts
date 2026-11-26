import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50);
  const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return proxyJson('GET', `/api/triggers/${encodeURIComponent(params.id)}/deliveries?limit=${bounded}`);
}
