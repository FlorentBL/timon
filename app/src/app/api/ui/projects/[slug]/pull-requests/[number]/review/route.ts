import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Prepares the brief of a relecture: nothing starts. */
export async function POST(req: Request, props: { params: Promise<{ slug: string; number: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/review`,
    body,
  );
}
