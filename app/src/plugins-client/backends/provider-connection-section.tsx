'use client';

/**
 * The Connection section of a provider page (`settings.provider.section`,
 * key `connection`): one row for the sign-in of this computer, then one row
 * per subscription account of THIS provider, with every gesture of the former
 * "Subscription accounts" tab — add, sign in, rename, assign, delete.
 *
 * The sign-in command and its steps show only after "Connect": typed in
 * Timon's terminal or copied, then unfolded under the row for a terminal of
 * one's own. A computer that is not signed in while an account is says so
 * without alarm: missions run on the accounts.
 *
 * A provider whose host sign-in Timon can keep (`connection.host`, Claude)
 * signs this computer in in the app: "Sign in" opens the page-and-code
 * dialog, and the "…" menu goes back to the terminal's session or signs in
 * again. The command stays one click away ("Show the sign-in command").
 * When Timon runs as a macOS service outside the user's session, no sign-in
 * can be read there: the row says so and offers the long-lived token alone.
 *
 * Painted only when there is something to say: a sign-in command, a known
 * sign-in state, or backends that take accounts. Accounts are listed in the
 * daemon's order: a mission is never moved from one to another, so there is
 * no order to set.
 */
import { useState, type ReactElement } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { CommandToRun } from '@/components/command-to-run';
import { runSignInCommand, signInLabel } from '@/components/provider-cli/provider-cli-cards';
import type { ProviderCliSignInOutcome } from '@/components/provider-cli/provider-cli-context';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { TonePill } from '@/components/provider-page/provider-status-pill';
import { BackendAccountsList } from '@/components/settings/backend-accounts-settings';
import { fetchProviderClis } from '@/lib/provider-clis';
import { forgetHostSignIn, type HostFlowKind } from '@/lib/host-sign-in';
import { HostSignInDialog } from '@/components/provider-cli/host-sign-in-dialog';
import type { ProviderOverview, StatusTone } from '@/lib/provider-overview';
import { t } from '@/lib/i18n';

/** Whether the section has anything to show for this provider. */
export function hasConnection(provider: Pick<ProviderOverview, 'connection'>): boolean {
  const { connection } = provider;
  return connection.signInCommand !== null || connection.signedIn !== null || connection.acceptsAccounts;
}

/**
 * What the computer row says, `null` when the daemon cannot tell. Not signed
 * in here but an account is: missions run on it, nothing to fix.
 */
export function computerState(connection: ProviderOverview['connection']): { tone: StatusTone; key: string } | null {
  if (connection.host?.tokenOnly) {
    return connection.host.token?.stored
      ? { tone: 'ready', key: 'hostSignIn.status.tokenOnlySet' }
      : { tone: 'action', key: 'hostSignIn.status.tokenOnly' };
  }
  if (connection.host?.kept) return { tone: 'ready', key: 'hostSignIn.status.kept' };
  if (connection.signedIn === true) return { tone: 'ready', key: 'providerPage.connection.signedIn' };
  if (connection.signedIn === null) return null;
  if (connection.accounts.some((account) => account.connected)) return { tone: 'off', key: 'providerPage.connection.usesAccounts' };
  return { tone: 'action', key: 'providerPage.connection.signedOut' };
}

export function ConnectionSection(): ReactElement | null {
  const page = useProviderPage();
  if (!page || !hasConnection(page.provider)) return null;
  const { provider } = page;
  const { connection } = provider;
  return (
    <ProviderSection title={t('providerPage.connection.title')}>
      {connection.signInCommand !== null || connection.signedIn !== null
        ? <ComputerRow connection={connection} name={provider.name} refresh={page.refresh} />
        : null}
      {connection.acceptsAccounts ? (
        <div className="flex flex-col gap-0.5" data-connection="accounts">
          <BackendAccountsList backends={provider.backends.map((backend) => backend.id)} onChanged={() => void page.refresh()} />
        </div>
      ) : null}
    </ProviderSection>
  );
}

function ComputerRow({ connection, name, refresh }: { connection: ProviderOverview['connection']; name: string; refresh: () => Promise<void> }): ReactElement {
  const [checking, setChecking] = useState(false);
  const [dialog, setDialog] = useState<HostFlowKind | null>(null);
  const host = connection.host ?? null;
  // Signed in in the app, into Timon's folder, rather than with the terminal's command.
  const inApp = host?.browser === true;
  // A service outside the session reads no sign-in, kept or the terminal's: the token alone runs it.
  const tokenOnly = host?.tokenOnly === true;
  const command = tokenOnly ? null : connection.signInCommand;
  /** Unfolded after "Connect": what happened to the command, and the command itself. */
  const [steps, setSteps] = useState<ProviderCliSignInOutcome | 'shown' | null>(null);
  const state = computerState(connection);
  const usesAccounts = state?.key === 'providerPage.connection.usesAccounts';

  // Asking the CLIs again refreshes the daemon's sign-in verdicts; the page then reads them.
  const checkAgain = async (): Promise<void> => {
    setChecking(true);
    try {
      await fetchProviderClis().catch(() => null);
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const connect = async (): Promise<void> => {
    if (command === null) return;
    setSteps(await runSignInCommand(command));
  };

  const backToTerminal = async (): Promise<void> => {
    if (!host) return;
    try {
      await forgetHostSignIn(host.backend);
      toast.success(t('hostSignIn.forgotten'));
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const offerConnect = !tokenOnly && (command !== null || inApp) && connection.signedIn !== true && !host?.kept;
  const offerToken = tokenOnly && host?.token?.stored !== true;
  return (
    <ProviderSettingRow
      data-connection="computer"
      data-signed-in={connection.signedIn === null ? undefined : String(connection.signedIn)}
      title={t('providerPage.connection.computer')}
      status={state ? <TonePill tone={state.tone} className="flex">{t(state.key, { identity: host?.identity ?? '' })}</TonePill> : null}
      action={offerToken ? (
        <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => setDialog('token')} data-host-sign-in-offer="token">
          <KeyRound aria-hidden className="size-3.5" />
          {t('hostSignIn.token.createAction')}
        </Button>
      ) : offerConnect ? (
        <Button type="button" size="sm" variant={usesAccounts ? 'outline' : 'default'} className="h-8 gap-1.5"
          onClick={inApp ? () => setDialog('login') : () => void connect()} data-host-sign-in-offer={inApp ? 'login' : undefined}>
          <LogIn aria-hidden className="size-3.5" />
          {t(inApp ? 'providerClis.signIn' : 'providerPage.connection.connect')}
        </Button>
      ) : null}
      menu={<>
        <DropdownMenuItem disabled={checking} onSelect={() => void checkAgain()}>{t('providerPage.connection.checkAgain')}</DropdownMenuItem>
        {host?.kept ? <>
          {inApp ? <DropdownMenuItem onSelect={() => setDialog('login')}>{t('providerPage.connection.reconnect')}</DropdownMenuItem> : null}
          <DropdownMenuItem onSelect={() => void backToTerminal()}>{t('hostSignIn.useTerminal')}</DropdownMenuItem>
        </> : null}
        {inApp && !host?.kept && connection.signedIn === true
          ? <DropdownMenuItem onSelect={() => setDialog('login')}>{t('hostSignIn.useBrowser')}</DropdownMenuItem>
          : null}
        {command !== null && connection.signedIn === true && !host?.kept
          ? <DropdownMenuItem onSelect={() => void connect()}>{t(inApp ? 'hostSignIn.reconnectTerminal' : 'providerPage.connection.reconnect')}</DropdownMenuItem>
          : null}
        {command !== null && steps === null
          ? <DropdownMenuItem onSelect={() => setSteps('shown')}>{t('providerPage.connection.showCommand')}</DropdownMenuItem>
          : null}
      </>}
    >
      {steps !== null && command !== null ? (
        <div className="space-y-2 rounded-md bg-background/60 p-3" data-sign-in-steps>
          {steps !== 'shown'
            ? <p role="status" className="m-0 text-xs text-muted-foreground">{signInLabel(`providerClis.signInOutcome.${steps}`, connection.signInThen)}</p>
            : null}
          <CommandToRun command={command} label={signInLabel('providerClis.signInHint', connection.signInThen)} />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={checking} onClick={() => void checkAgain()}>
              {t('providerPage.connection.checkAgain')}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSteps(null)}>
              {t('providerPage.connection.hideSteps')}
            </Button>
          </div>
        </div>
      ) : null}
      {host ? (
        <HostSignInDialog backend={host.backend} name={name} kind={dialog ?? 'login'} open={dialog !== null}
          onOpenChange={(open) => { if (!open) setDialog(null); }} onDone={() => void refresh()} />
      ) : null}
    </ProviderSettingRow>
  );
}
