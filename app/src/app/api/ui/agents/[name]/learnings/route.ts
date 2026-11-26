import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, props: { params: Promise<{ name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/agents/${encodeURIComponent(params.name)}/learnings`);
}
