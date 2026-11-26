import { proxyJson } from '@/lib/ui/proxy';

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return proxyJson('GET', `/api/workflows/${encodeURIComponent(params.id)}/proposals`);
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return proxyJson('POST', `/api/workflows/${encodeURIComponent(params.id)}/proposals`, await request.json());
}
