/**
 * The status line of a provider: one table, read top to bottom. Each row
 * changes the fewest inputs needed to show which fact wins over which.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerStatus, type ProviderStatus, type ProviderStatusInput } from './provider-status.js';

const BASE: ProviderStatusInput = {
  disabled: false,
  refused: false,
  programMissing: false,
  needsAuthorization: false,
  failed: false,
  signedIn: null,
  accountConnected: false,
  secretRequired: false,
  secretPresent: false,
  usable: true,
};

const CASES: [string, Partial<ProviderStatusInput>, ProviderStatus][] = [
  ['installed, nothing known about the sign-in', {}, 'available'],
  ['host signed in', { signedIn: true }, 'connected'],
  ['host signed out', { signedIn: false }, 'not-connected'],
  ['host signed out, one account signed in', { signedIn: false, accountConnected: true }, 'connected'],
  ['account signed in, sign-in unknown', { accountConnected: true }, 'connected'],
  ['key required and present', { secretRequired: true, secretPresent: true }, 'connected'],
  ['key required and missing', { secretRequired: true, secretPresent: false, usable: false }, 'not-connected'],
  ['key required and missing, a sign-in known', { signedIn: true, secretRequired: true, secretPresent: false, usable: false }, 'not-connected'],
  ['key required and missing, backend still listed', { signedIn: true, secretRequired: true, secretPresent: false }, 'not-connected'],
  ['key present but backend still inactive', { secretRequired: true, secretPresent: true, usable: false }, 'not-connected'],
  ['no backend active, no reason known', { usable: false }, 'not-connected'],
  ['program missing', { programMissing: true, usable: false }, 'not-installed'],
  ['program missing wins over a failed plugin', { programMissing: true, failed: true }, 'not-installed'],
  ['program waits for authorization', { needsAuthorization: true }, 'needs-authorization'],
  ['authorization wins over the failed mount it causes', { needsAuthorization: true, failed: true }, 'needs-authorization'],
  ['missing program wins over authorization', { programMissing: true, needsAuthorization: true }, 'not-installed'],
  ['plugin failed for another reason', { failed: true, signedIn: true }, 'blocked'],
  ['refused by policy', { refused: true }, 'blocked'],
  ['refusal wins over a missing program', { refused: true, programMissing: true }, 'blocked'],
  ['refusal wins over a sign-in', { refused: true, signedIn: true }, 'blocked'],
  ['disabled', { disabled: true }, 'disabled'],
  ['disabled wins over everything', { disabled: true, refused: true, programMissing: true, needsAuthorization: true, failed: true, signedIn: true }, 'disabled'],
];

for (const [name, change, expected] of CASES) {
  test(`provider status: ${name} → ${expected}`, () => {
    assert.equal(providerStatus({ ...BASE, ...change }), expected);
  });
}
