import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The end of a failed check's log. Only the check's `url` crosses: the
 *  daemon reads it only when it names a job of the repository's own CI. */
export async function GET(req: Request, props: { params: Promise<{ slug: string; number: string }> }): Promise<Response> {
  const params = await props.params;
  const url = new URL(req.url).searchParams.get('url') ?? '';
  return proxyJson(
    'GET',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/check-log?${new URLSearchParams({ url })}`,
  );
}
