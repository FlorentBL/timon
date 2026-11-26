import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; id: string }> };

/** Drops the resolution, its objects and its waiting publication. */
export async function POST(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-conflicts/${encodeURIComponent(params.id)}/discard`,
    {},
  );
}
