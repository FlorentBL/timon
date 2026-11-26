import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The diff of a pull request, as text read from the forge. */
export async function GET(
  _req: Request,
  props: { params: Promise<{ slug: string; number: string }> }
): Promise<Response> {
  const params = await props.params;
  return proxyJson(
    'GET',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/diff`,
  );
}
