import { proxyJson, proxyMedia } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; attachmentId: string }> };

const path = ({ id, attachmentId }: Ctx['params']) =>
  `/api/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`;

// Streamed with the daemon's headers (type, disposition, sandbox). Only the
// download flag crosses from the browser's query string.
export async function GET(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const download = new URL(req.url).searchParams.get('download') === '1';
  return proxyMedia(`${path(params)}${download ? '?download=1' : ''}`, req);
}

export async function DELETE(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', path(params));
}
