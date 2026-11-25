import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The project's extra folders have their own door on the daemon: only a
// person's session writes them, never a token.
const path = (slug: string): string => `/api/projects/${encodeURIComponent(slug)}/extra-dirs`;

export async function GET(_req: Request, { params }: { params: { slug: string } }): Promise<Response> {
  return proxyJson('GET', path(params.slug));
}

export async function PUT(req: Request, { params }: { params: { slug: string } }): Promise<Response> {
  return proxyJson('PUT', path(params.slug), await req.json().catch(() => ({})));
}

export async function POST(req: Request, { params }: { params: { slug: string } }): Promise<Response> {
  return proxyJson('POST', path(params.slug), await req.json().catch(() => ({})));
}

export async function DELETE(req: Request, { params }: { params: { slug: string } }): Promise<Response> {
  return proxyJson('DELETE', path(params.slug), await req.json().catch(() => ({})));
}
