import { isMachineId } from '@/lib/machines/machine-id';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Probes the machine now: reachable, version, apiLevel (recorded by the daemon). */
export async function GET(_req: Request, props: Params): Promise<Response> {
  const params = await props.params;
  if (!isMachineId(params.id)) return Response.json({ error: 'machine not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  return proxyJson('GET', `/api/machines/${encodeURIComponent(params.id)}/status`);
}
