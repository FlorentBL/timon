import { ConfirmEmailClient } from './confirm-email-client';

export const dynamic = 'force-dynamic';

export default async function ConfirmEmailPage(props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  return <ConfirmEmailClient token={params.token} />;
}
