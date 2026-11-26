import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, props: { params: Promise<{ slug: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', `/api/mcp-apps/${encodeURIComponent(params.slug)}`);
}
