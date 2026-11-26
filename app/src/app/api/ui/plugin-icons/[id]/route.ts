import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Gallery picto (`timon.icon`) of an installed plugin. Same shape as `plugin-covers`. */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const rev = new URL(request.url).searchParams.get('rev');
  const query = rev ? `?rev=${encodeURIComponent(rev)}` : '';
  return proxyBinary(`/plugins/${encodeURIComponent(params.id)}/icon${query}`, { securityHeaders: true });
}
