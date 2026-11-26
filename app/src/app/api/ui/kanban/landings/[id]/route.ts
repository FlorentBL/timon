import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/kanban/landings/${encodeURIComponent(params.id)}`);
}
