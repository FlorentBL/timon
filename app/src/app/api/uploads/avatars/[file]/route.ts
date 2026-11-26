import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, props: { params: Promise<{ file: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyBinary(`/api/uploads/avatars/${encodeURIComponent(params.file)}`);
}
