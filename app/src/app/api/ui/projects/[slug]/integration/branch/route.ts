import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string }> };

// The Kanban planner's branch check. Only the name crosses: the daemon is the
// one judge of it, and refuses any other field.
export async function POST(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({})) as { branch?: unknown };
  return proxyJson('POST', `/api/projects/${encodeURIComponent(params.slug)}/integration/branch`, {
    branch: body.branch,
  });
}
