import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, props: { params: Promise<{ runId: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/workflows/runs/${encodeURIComponent(params.runId)}/cancel`);
}
