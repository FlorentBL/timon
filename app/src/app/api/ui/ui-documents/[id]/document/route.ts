import { proxyUiDocument } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The document's HTML, for the chat card's sandboxed iframe. Session cookie only. */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyUiDocument(`/api/ui-documents/${encodeURIComponent(params.id)}/document`);
}
