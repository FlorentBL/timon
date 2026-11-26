import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; number: string }> };

/** Prepares "update the branch" as a publication: nothing reaches GitHub before it is published. */
export async function POST(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/update-branch`,
    {},
  );
}
