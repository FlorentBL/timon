/**
 * The proposals store reads again only the project a `forge_proposals_changed`
 * frame names; a frame it cannot read names none (every project is read).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedProject } from './use-forge-proposals';

const frame = (data: unknown) => ({ data }) as MessageEvent;

test('the project of a forge_proposals_changed frame', () => {
  assert.equal(changedProject(frame(JSON.stringify({ kind: 'forge_proposals_changed', project: 'acme', proposalId: 'p' }))), 'acme');
  for (const data of [undefined, '', 'not json', '{"project":""}', '{"project":3}', 'null', '[]']) {
    assert.equal(changedProject(frame(data)), null, String(data));
  }
});
