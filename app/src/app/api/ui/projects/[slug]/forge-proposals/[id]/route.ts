import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; id: string }> };

const path = (p: Awaited<Ctx['params']>) =>
  `/api/projects/${encodeURIComponent(p.slug)}/forge-proposals/${encodeURIComponent(p.id)}`;

export async function GET(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', path(params));
}

/** A person edits the text; the daemon checks it again. */
export async function PATCH(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('PATCH', path(params), body);
}
