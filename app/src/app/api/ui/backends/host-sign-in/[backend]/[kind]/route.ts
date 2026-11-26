import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ backend: string; kind: string }> };

/** The two flows the daemon serves; anything else never leaves this proxy. */
async function target(context: Params): Promise<string | null> {
  const params = await context.params;
  if (params.kind !== 'login' && params.kind !== 'token') return null;
  return `/api/backends/host-sign-in/${encodeURIComponent(params.backend)}/${params.kind}`;
}

const notFound = (): Response => Response.json({ error: 'not found' }, { status: 404 });

// The daemon binds the flow to the session cookie this proxy forwards.
export async function GET(_req: Request, context: Params): Promise<Response> {
  const path = await target(context);
  return path ? proxyJson('GET', path) : notFound();
}

export async function POST(req: Request, context: Params): Promise<Response> {
  const path = await target(context);
  return path ? proxyJson('POST', path, await req.json().catch(() => ({}))) : notFound();
}

export async function DELETE(_req: Request, context: Params): Promise<Response> {
  const path = await target(context);
  return path ? proxyJson('DELETE', path) : notFound();
}
