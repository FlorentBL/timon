import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; id: string }> };

/** One file's resolution; the daemon validates the body (`choice`, `path`, `text`). */
export async function PUT(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(
    'PUT',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-conflicts/${encodeURIComponent(params.id)}/files`,
    body,
  );
}
