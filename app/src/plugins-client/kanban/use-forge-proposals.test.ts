/**
 * The proposals store shared by the page: another account's proposals never
 * stay on screen once the account changes, and an answer still on its way
 * for the previous account lands nowhere. It reads again only the project a
 * `forge_proposals_changed` frame names; a frame it cannot read names none
 * (every project is read).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceAccount } from '@/lib/account-change';
import type { ForgeProposal } from './forge-proposals-api';
import { changedProject } from './use-forge-proposals';

const frame = (data: unknown) => ({ data }) as MessageEvent;

test('the project of a forge_proposals_changed frame', () => {
  assert.equal(changedProject(frame(JSON.stringify({ kind: 'forge_proposals_changed', project: 'acme', proposalId: 'p' }))), 'acme');
  for (const data of [undefined, '', 'not json', '{"project":""}', '{"project":3}', 'null', '[]']) {
    assert.equal(changedProject(frame(data)), null, String(data));
  }
});

function proposal(id: string): ForgeProposal {
  return {
    id, project: 'acme', repo: 'acme/widgets', kind: 'comment',
    target: { type: 'pull', number: 12, url: 'https://github.com/acme/widgets/pull/12' },
    body: 'Thanks!', state: 'draft', trigger: 'person', key: id, source_ref: null, account: null, url: null,
    error: null, created_at: 1, updated_at: 1, published_at: null,
  };
}

test('an account change empties the proposals held and reads them again for the new account', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // Each account sees its own proposals; the second answer for `alice` is held back.
  let account = 'alice';
  let hold: ((r: Response) => void) | null = null;
  let reads = 0;
  install('fetch', async (input: string) => {
    assert.equal(String(input), '/api/ui/projects/acme/forge-proposals');
    reads += 1;
    const answer = Response.json({ proposals: [proposal(`${account}-1`)] });
    if (account === 'alice' && reads === 2) return new Promise<Response>((resolve) => { hold = resolve; });
    return answer;
  });

  announceAccount('alice');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useForgeProposals } = await import('./use-forge-proposals');
  const shown: string[][] = [];
  function Probe() {
    const { pending, reload } = useForgeProposals(['acme']);
    shown.push(pending.map((p) => p.id));
    (globalThis as { reloadProposals?: () => void }).reloadProposals = reload;
    return null;
  }
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(React.createElement(Probe)); });
    await settle();
    assert.deepEqual(shown.at(-1), ['alice-1']);

    // A read for alice is still on its way when the account changes.
    await React.act(async () => { (globalThis as { reloadProposals?: () => void }).reloadProposals?.(); });
    assert.ok(hold, 'the second read for alice is in flight');
    account = 'bob';
    await React.act(async () => { announceAccount('bob'); });
    await settle();
    assert.deepEqual(shown.at(-1), ['bob-1'], 'read again for bob');
    assert.equal(reads, 3);

    // alice's late answer does not come back over bob's.
    await React.act(async () => { hold?.(Response.json({ proposals: [proposal('alice-late')] })); });
    await settle();
    assert.deepEqual(shown.at(-1), ['bob-1']);

    // Signed out: emptied, and nothing read for nobody.
    await React.act(async () => { announceAccount(null); });
    await settle();
    assert.deepEqual(shown.at(-1), []);
    assert.equal(reads, 3);
  } finally {
    await React.act(async () => { root.unmount(); });
    announceAccount(null);
    delete (globalThis as { reloadProposals?: () => void }).reloadProposals;
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  }
});
