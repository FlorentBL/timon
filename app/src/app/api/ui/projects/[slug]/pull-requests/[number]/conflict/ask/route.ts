import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; number: string }> };

/** Prepares the comment asking the contributor to resolve their conflict. */
export async function POST(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/conflict/ask`,
    {},
  );
}
