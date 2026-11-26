import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RELAYED = ['span_limit', 'payload'] as const;

export async function GET(req: Request, props: { params: Promise<{ traceId: string }> }): Promise<Response> {
  const params = await props.params;
  const incoming = new URL(req.url).searchParams;
  const outgoing = new URLSearchParams();
  for (const name of RELAYED) {
    const value = incoming.get(name);
    if (value !== null) outgoing.set(name, value);
  }
  const qs = outgoing.size > 0 ? `?${outgoing.toString()}` : '';
  return proxyJson('GET', `/api/trace/${encodeURIComponent(params.traceId)}${qs}`);
}
