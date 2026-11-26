import { MessagesClient } from './messages-client';

export const dynamic = 'force-dynamic';

export default async function MessagesPage(
  props: {
    searchParams: Promise<{ agent?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  return <MessagesClient initialAgent={searchParams.agent} />;
}
