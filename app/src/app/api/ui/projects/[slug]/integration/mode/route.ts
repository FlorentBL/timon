/**
 * Same-origin proxy to the mode alone of a project's landing setting: local
 * merge or pull requests. The daemon answers it to any signed-in account,
 * without the account, the folder or the remote the full setting names.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('GET', `/api/projects/${encodeURIComponent(params.slug)}/integration/mode`);
}
