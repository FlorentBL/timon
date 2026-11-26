import { proxySse, sseClientQuery } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxySse(
    `/api/missions/${encodeURIComponent(params.id)}/stream${sseClientQuery(request)}`,
    request,
  );
}
