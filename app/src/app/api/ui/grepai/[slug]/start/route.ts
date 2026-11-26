import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, props: { params: Promise<{ slug: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/grepai/${encodeURIComponent(params.slug)}/start`, {});
}
