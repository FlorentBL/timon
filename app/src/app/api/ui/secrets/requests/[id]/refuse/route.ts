import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The owner refuses a secret request. Browser session only, like `provide`. */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/secrets/requests/${encodeURIComponent(params.id)}/refuse`, {});
}
