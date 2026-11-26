import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/tasks/${params.id}`);
}

export async function PUT(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', `/api/tasks/${params.id}`, body);
}

// Only the chain flag crosses: the rest of the browser's query string never reaches the daemon.
export async function DELETE(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const chain = new URL(req.url).searchParams.get('chain') === '1';
  return proxyJson('DELETE', `/api/tasks/${params.id}${chain ? '?chain=1' : ''}`);
}
