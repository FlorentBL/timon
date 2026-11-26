import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Photos an agent set on another agent (`agent_set_avatar`): the daemon serves them, the browser reaches them here.
export async function GET(_req: Request, props: { params: Promise<{ file: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyBinary(`/api/uploads/agents/${encodeURIComponent(params.file)}`);
}
