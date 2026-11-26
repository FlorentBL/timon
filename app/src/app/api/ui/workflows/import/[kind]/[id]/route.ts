import { proxyJson } from '@/lib/ui/proxy';

export async function POST(request: Request, props: { params: Promise<{ kind: string; id: string }> }) {
  const params = await props.params;
  const body = await request.json().catch(() => ({}));
  return proxyJson('POST', `/api/workflows/import/${encodeURIComponent(params.kind)}/${encodeURIComponent(params.id)}`, body);
}
