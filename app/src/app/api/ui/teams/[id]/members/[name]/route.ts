import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, props: { params: Promise<{ id: string; name: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson(
    'DELETE',
    `/api/teams/${encodeURIComponent(params.id)}/members/${encodeURIComponent(params.name)}`,
  );
}
