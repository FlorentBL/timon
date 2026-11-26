import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// No body crosses: the daemon only removes the folder and keeps the branch.
export async function POST(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/tasks/${encodeURIComponent(params.id)}/worktree/detach`, {});
}
