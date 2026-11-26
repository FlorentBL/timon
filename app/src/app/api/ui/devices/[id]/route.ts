import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };
const target = (id: string) => `/api/devices/${encodeURIComponent(id)}`;

/** Rename: the daemon validates `{ name }` (zod, strict). */
export async function PATCH(req: Request, props: Params): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', target(params.id), body);
}

/** Revoke: effective on the device's next request. */
export async function DELETE(_req: Request, props: Params): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', target(params.id));
}
