import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// Nothing crosses but the id: the daemon decides whether the forge is asked.
export async function POST(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/kanban/landings/${encodeURIComponent(params.id)}/checks`, {});
}
