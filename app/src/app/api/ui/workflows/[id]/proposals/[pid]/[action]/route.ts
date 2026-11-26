import { proxyJson } from '@/lib/ui/proxy';

export async function POST(
  _request: Request,
  props: { params: Promise<{ id: string; pid: string; action: string }> }
) {
  const params = await props.params;
  return proxyJson('POST', `/api/workflows/${encodeURIComponent(params.id)}/proposals/${encodeURIComponent(params.pid)}/${encodeURIComponent(params.action)}`);
}
