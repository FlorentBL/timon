import { proxyPluginRequest, type PluginRouteParams } from '@/lib/ui/plugin-proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: PluginRouteParams };
export async function GET(request: Request, props: Params): Promise<Response> {
  const params = await props.params;
  return proxyPluginRequest('GET', request, params);
}
export async function POST(request: Request, props: Params): Promise<Response> {
  const params = await props.params;
  return proxyPluginRequest('POST', request, params);
}
export async function PUT(request: Request, props: Params): Promise<Response> {
  const params = await props.params;
  return proxyPluginRequest('PUT', request, params);
}
export async function PATCH(request: Request, props: Params): Promise<Response> {
  const params = await props.params;
  return proxyPluginRequest('PATCH', request, params);
}
export async function DELETE(request: Request, props: Params): Promise<Response> {
  const params = await props.params;
  return proxyPluginRequest('DELETE', request, params);
}
