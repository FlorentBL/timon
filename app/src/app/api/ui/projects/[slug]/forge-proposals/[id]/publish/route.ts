import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; id: string }> };

/** A person publishes the proposal on GitHub, with the text they read. */
export async function POST(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-proposals/${encodeURIComponent(params.id)}/publish`,
    body,
  );
}
