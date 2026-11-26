import { PipelinesClient } from './pipelines-client';

export const dynamic = 'force-dynamic';

export default async function PipelinesPage(
  props: {
    searchParams: Promise<{ run?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  return <PipelinesClient initialRun={searchParams.run} />;
}
