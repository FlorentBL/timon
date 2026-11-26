/**
 * `onAccountSwitch`, the change of account a plugin follows through
 * `@timon/ui` `onAccountChange`: called when the signed-in account becomes
 * another one or signs out, never for the first naming nor a repeat, and
 * without the account's id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceAccount, onAccountSwitch } from './account-change';

test('a switch is reported once per real change, with no id', () => {
  announceAccount(null);
  const calls: unknown[][] = [];
  const stop = onAccountSwitch((...args: unknown[]) => { calls.push(args); });
  try {
    announceAccount('alice');
    assert.equal(calls.length, 0, 'naming the first account is no change');
    announceAccount('alice');
    assert.equal(calls.length, 0, 'the same account announced again is no change');
    announceAccount('bob');
    assert.equal(calls.length, 1, 'another account');
    announceAccount(null);
    assert.equal(calls.length, 2, 'signed out');
    announceAccount('carol');
    assert.equal(calls.length, 2, 'signing in after a sign-out was already reported');
    assert.ok(calls.every((args) => args.length === 0), 'the listener learns no id');
  } finally {
    stop();
  }
  announceAccount('dave');
  assert.equal(calls.length, 2, 'nothing after the unsubscribe');
  announceAccount(null);
});

test('a listener added while an account is signed in follows from that account', () => {
  announceAccount('alice');
  let calls = 0;
  const stop = onAccountSwitch(() => { calls += 1; });
  try {
    announceAccount('bob');
    assert.equal(calls, 1);
  } finally {
    stop();
    announceAccount(null);
  }
});
