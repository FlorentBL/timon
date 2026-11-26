import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; id: string }> };

/** An agent with no tool suggests a text for one file; the daemon never applies it. */
export async function POST(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-conflicts/${encodeURIComponent(params.id)}/suggest`,
    body,
  );
}
