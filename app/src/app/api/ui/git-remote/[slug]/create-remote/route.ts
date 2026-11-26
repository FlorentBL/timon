import { proxyJson } from '@/lib/ui/proxy';
import { repoSuffix } from '@/lib/ui/git-repo-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, props: { params: Promise<{ slug: string }> }): Promise<Response> {
  const params = await props.params;
  // The body carries the visibility chosen in the UI; missing = private (the
  // orchestrator's default), so a request without a body stays valid.
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/git-remote/${encodeURIComponent(params.slug)}/create-remote${repoSuffix(req)}`, body);
}
