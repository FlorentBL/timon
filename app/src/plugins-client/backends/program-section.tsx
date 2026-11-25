'use client';

/**
 * The Program section of a provider page: what Timon runs on this computer for
 * this provider, one row per program. The row says its version and offers ONE
 * gesture — install when it is missing, authorize when a third-party plugin
 * waits for it, update when a newer one is out. The rest folds under
 * Advanced, opened from the row's menu (or by itself when something there
 * needs fixing): the ONE path a launch runs, the path an operator pins when the
 * program lives where Timon does not look, and, for a third-party plugin only,
 * the operator's security authorization.
 *
 * Everything shown is the daemon's (`/api/providers/overview`): this section
 * never decides what is installed, authorized or blocked, and reads the
 * provider again after each of its own gestures. A provider shipped in the
 * release asks no authorization, so none is shown for it — whatever an older
 * daemon would answer.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ArrowUpCircle, Download, ExternalLink, FolderOpen, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { CommandToRun } from '@/components/command-to-run';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import { InstallConsole } from '@/components/provider-cli/provider-cli-cards';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { TonePill } from '@/components/provider-page/provider-status-pill';
import { pinBinary, pinPathExample, recheckBinaries, unpinBinary } from '@/lib/backend-binaries';
import { desktopBridge } from '@/lib/desktop';
import { nativePickerReachesDaemon } from '@/lib/directory-pick';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { checkProviderClis, fetchProviderCliInstall, startProviderCliInstall, type InstallJob } from '@/lib/provider-clis';
import {
  programState, shownAuthorization,
  type ProgramAuthorization, type ProgramState, type ProviderOverview, type ProviderProgramView, type StatusTone,
} from '@/lib/provider-overview';
import { fetchProviders, installAcpAgent, providerToAuthorize, type ProviderPlugin } from '@/lib/providers';
import { t } from '@/lib/i18n';
import { ProviderAuthorizeDialog } from './provider-authorize-dialog';

/** How often a running installer is read: often enough for its console to feel live. */
const POLL_MS = 1000;

const AUTHORIZATION_TONE: Readonly<Record<ProgramAuthorization, StatusTone>> = {
  ready: 'ready',
  authorize: 'action',
  install: 'action',
  refused: 'blocked',
};

export function ProgramSection(): ReactElement | null {
  const page = useProviderPage();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<ProviderPlugin | null>(null);

  if (!page) return null;
  const { provider } = page;
  if (provider.programs.length === 0 && !provider.catalogAgent) return null;
  const pluginId = provider.pluginId;

  const recheck = async (): Promise<void> => {
    setBusy(true);
    try {
      const [binaries] = await Promise.allSettled([recheckBinaries(), checkProviderClis()]);
      if (binaries.status === 'rejected') throw binaries.reason;
      if (binaries.value.configError) toast.error(t(`binariesSettings.errors.${binaries.value.configError}`));
      else toast.success(t('providerPage.program.rechecked'));
      await page.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The dialog shows what the daemon resolves at the click, never what the overview read earlier.
  const review = async (): Promise<void> => {
    if (!pluginId) return;
    setBusy(true);
    try {
      const target = providerToAuthorize(await fetchProviders(), pluginId);
      if (target) setReviewing(target);
      else await page.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ProviderSection title={t('providerPage.program.title')}>
        {provider.catalogAgent ? <CatalogAgent name={provider.name} agent={provider.catalogAgent} /> : null}
        {provider.programs.map((program) => (
          <Program
            key={program.name}
            program={program}
            titled={provider.programs.length > 1 || provider.catalogAgent !== null}
            plugin={provider.origin === 'plugin' ? provider.plugin : null}
            authorization={shownAuthorization(provider, program)}
            busy={busy}
            onReview={() => void review()}
            onRecheck={() => void recheck()}
          />
        ))}
      </ProviderSection>
      <ProviderAuthorizeDialog provider={reviewing} onClose={() => setReviewing(null)} onAuthorized={page.refresh} />
    </>
  );
}

/** The row's one line: what blocks it first, then where the program stands, its version in it. */
export function programStatus(program: ProviderProgramView, state: ProgramState, authorization: ProgramAuthorization | null): { tone: StatusTone; text: string } {
  if (authorization === 'refused' || authorization === 'authorize') {
    return { tone: AUTHORIZATION_TONE[authorization], text: t(`providerPage.program.authorization.${authorization}.label`) };
  }
  if (state === 'installed') {
    return { tone: 'ready', text: program.version ? t('providerPage.program.versionLine', { version: program.version }) : t('providerPage.program.state.installed') };
  }
  if (state === 'update' && program.version && program.latest) {
    return { tone: 'action', text: t('providerPage.program.versionUpdate', { version: program.version, latest: program.latest }) };
  }
  return { tone: 'action', text: stateLabel(program, state) };
}

function Program({ program, titled, plugin, authorization, busy, onReview, onRecheck }: {
  program: ProviderProgramView;
  /** Several programs on the page: each row says whose it is. */
  titled: boolean;
  /** The third-party plugin that brings it, said under Advanced. */
  plugin: ProviderOverview['plugin'];
  authorization: ProgramAuthorization | null;
  busy: boolean;
  onReview: () => void;
  onRecheck: () => void;
}): ReactElement {
  const page = useProviderPage();
  const refresh = page?.refresh;
  const { job, start } = useInstallJob(program.name, program.installable, refresh);
  const state = programState(program);
  // Opened by itself when what is there needs fixing: the path set no longer runs, a refusal says why.
  const [advanced, setAdvanced] = useState(state === 'brokenPin' || authorization === 'refused');
  const running = job?.state === 'running';
  const failed = job?.state === 'failed' ? job : null;
  // The official installer runs only where Timon can run it, never over a generation the
  // provider does not support (the installer would replace it).
  const official = program.installable && !program.unsupportedVersion;
  const canInstall = official && (program.path === null || program.bundled);
  const canUpdate = official && program.updateAvailable && !canInstall;
  const manual = failed?.result?.command ?? program.installCommand;
  const status = programStatus(program, state, authorization);
  const docs = !program.installable && program.installDocs && (state === 'missing' || program.updateAvailable || program.unsupportedVersion)
    ? program.installDocs
    : null;

  const action = canInstall ? (
    <Button type="button" size="sm" className="h-8 gap-1.5" disabled={running} onClick={() => void start()}>
      {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
      {t(running ? 'providerPage.program.installing' : 'providerPage.program.install')}
    </Button>
  ) : authorization === 'authorize' ? (
    <Button type="button" size="sm" className="h-8 gap-1.5" disabled={busy} onClick={onReview}>
      <ShieldAlert className="size-3.5" aria-hidden />
      {t('providerPage.program.authorization.review')}
    </Button>
  ) : canUpdate ? (
    <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" disabled={running} onClick={() => void start()}>
      {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowUpCircle className="size-3.5" aria-hidden />}
      {t(running ? 'providerPage.program.updating' : 'providerPage.program.update')}
    </Button>
  ) : null;

  return (
    <ProviderSettingRow
      data-program={program.name}
      title={titled ? program.name : t('providerPage.program.versionTitle')}
      status={<TonePill tone={status.tone} className="flex" data-program-state={state}>{status.text}</TonePill>}
      action={action}
      menu={<>
        <DropdownMenuItem disabled={busy} onSelect={onRecheck}>{t('providerPage.program.recheck')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setAdvanced((open) => !open)}>
          {t(advanced ? 'providerPage.program.hideAdvanced' : 'providerPage.program.showAdvanced')}
        </DropdownMenuItem>
        {docs ? (
          <DropdownMenuItem asChild>
            <a href={docs} target="_blank" rel="noreferrer noopener">
              {t('providerClis.docs', { name: page?.provider.name ?? program.name })}<ExternalLink className="ml-auto size-3" aria-hidden />
            </a>
          </DropdownMenuItem>
        ) : null}
      </>}
    >
      {job && (running || failed) ? <InstallConsole job={job} /> : null}
      {failed ? (
        <p role="alert" className="m-0 whitespace-pre-wrap break-words text-xs text-destructive">
          {failed.result?.reason ?? t('providerClis.failed')}
        </p>
      ) : null}
      {advanced ? (
        <div className="space-y-4 rounded-lg bg-background/60 p-3" data-program-advanced>
          {plugin ? (
            <p className="m-0 text-xs text-muted-foreground">
              {t('providerPage.program.plugin', { name: plugin.label, version: plugin.version })}
            </p>
          ) : null}
          {program.path ? (
            <div className="space-y-1">
              <p className="m-0 text-xs">
                <span className="text-muted-foreground">{t('providerPage.program.path')}</span>{' '}
                <span className="break-all" data-program-path>{program.path}</span>
              </p>
              {program.linkTarget || program.pinned ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">{t('providerPage.program.pathDetails')}</summary>
                  <div className="mt-1 space-y-1 text-muted-foreground">
                    {program.linkTarget ? (
                      <p className="m-0 break-all" data-program-link>{t('providerPage.program.link', { target: program.linkTarget })}</p>
                    ) : null}
                    {program.pinned ? <p className="m-0">{t('providerPage.program.pinned')}</p> : null}
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}
          {program.unsupportedVersion ? (
            <p className="m-0 text-xs text-amber-700 dark:text-amber-300">
              {t('providerClis.unsupportedVersion', { name: page?.provider.name ?? program.name, version: program.version ?? '' })}
            </p>
          ) : null}
          {authorization ? <Authorization authorization={authorization} reason={program.refusedReason} /> : null}
          {!running && (canInstall || canUpdate) && manual ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">{t('providerClis.manualSummary')}</summary>
              <CommandToRun command={manual} label={t('providerClis.manual')} />
            </details>
          ) : null}
          {program.pinKey ? <PinnedPath program={program} pinKey={program.pinKey} /> : null}
        </div>
      ) : null}
    </ProviderSettingRow>
  );
}

function stateLabel(program: ProviderProgramView, state: ProgramState): string {
  if (state === 'update' && program.latest) return t('providerPage.program.state.updateTo', { latest: program.latest });
  if (state === 'unsupported') return t('providerPage.program.state.unsupported', { version: program.version ?? '' });
  return t(`providerPage.program.state.${state}`);
}

function Authorization({ authorization, reason }: {
  authorization: ProgramAuthorization;
  reason: string | null;
}): ReactElement {
  return (
    <div className="space-y-1.5" data-program-authorization={authorization}>
      <p className="m-0 text-xs font-medium text-foreground">{t('providerPage.program.authorization.title')}</p>
      <TonePill tone={AUTHORIZATION_TONE[authorization]} className="text-foreground">
        {t(`providerPage.program.authorization.${authorization}.label`)}
      </TonePill>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t(`providerPage.program.authorization.${authorization}.body`)}</p>
      {authorization === 'refused' && reason ? (
        <p className="m-0 break-words text-[11px] text-muted-foreground">{t('providerPage.program.authorization.refused.detail', { reason })}</p>
      ) : null}
    </div>
  );
}

/**
 * The official installer of `name`, run by the daemon: started from here, or
 * already running when the page opens (the onboarding, another window), it is
 * followed until it ends, then the provider is read again.
 */
function useInstallJob(name: string, installable: boolean, onEnd: (() => Promise<void>) | undefined): {
  job: InstallJob | null;
  start: () => Promise<void>;
} {
  const [job, setJob] = useState<InstallJob | null>(null);
  const running = job?.state === 'running';

  useEffect(() => {
    if (!installable) return;
    let gone = false;
    void (async () => {
      try {
        const found = await fetchProviderCliInstall(name);
        if (!gone && found?.state === 'running') setJob(found);
      } catch { /* none ran: nothing to follow */ }
    })();
    return () => { gone = true; };
  }, [name, installable]);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await fetchProviderCliInstall(name);
          if (stopped) return;
          setJob(next);
          if (next.state !== 'running') await onEnd?.();
        } catch { /* the next tick asks again */ }
      })();
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [running, name, onEnd]);

  const start = useCallback(async () => {
    try {
      setJob(await startProviderCliInstall(name));
    } catch {
      setJob({
        name, command: '', state: 'failed', startedAt: Date.now(), finishedAt: Date.now(), lines: [], dropped: 0,
        result: { ok: false, command: null, reason: t('providerClis.startFailed') },
      });
    }
  }, [name]);

  return { job, start };
}

/**
 * The path pinned for the program (`host.binaries`): applied at once by the
 * daemon, which checks it and runs it from the next mission on. The path shown
 * as run stays the daemon's, never the text typed here.
 *
 * "Browse…" opens this computer's dialog only when the active daemon runs
 * here, in the desktop app; otherwise the daemon's own file browser.
 */
function PinnedPath({ program, pinKey }: { program: ProviderProgramView; pinKey: string }): ReactElement {
  const page = useProviderPage();
  const [draft, setDraft] = useState(program.pin ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nativeBrowse, setNativeBrowse] = useState(false);
  const { pickFile, dialog } = useDirectoryPicker();
  const inputId = `program-pin-${pinKey}`;

  useEffect(() => {
    // The pin is checked and run by the active machine's daemon: this computer's dialog only when that daemon is here.
    setNativeBrowse(typeof desktopBridge()?.selectExecutable === 'function' && nativePickerReachesDaemon(activeMachineId()));
  }, []);
  // A save, a removal or a recheck replaces the program's record: the field follows.
  useEffect(() => { setDraft(program.pin ?? ''); }, [program.pin]);

  const work = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await page?.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const browse = async (): Promise<void> => {
    const current = draft.trim() || program.path || '';
    const picker = nativeBrowse ? desktopBridge()?.selectExecutable : undefined;
    if (!picker) {
      // Any file: a program is `claude`, `claude.cmd` or `claude.exe` depending on the OS.
      const pick = await pickFile(current);
      if (pick.status === 'chosen') { setDraft(pick.path); setError(null); } else reportDirectoryPick(pick);
      return;
    }
    try {
      const picked = await picker(current || undefined);
      if (picked) { setDraft(picked); setError(null); }
    } catch {
      setError(t('binariesSettings.errors.browse'));
    }
  };

  const trimmed = draft.trim();
  const unchanged = trimmed === (program.pin ?? '');
  // The field names the program it wants (#1101: Ollama Cloud runs on the Codex CLI, and `ollama` was pinned).
  const example = pinPathExample(pinKey, [program.path, program.pin], typeof navigator === 'undefined' ? '' : navigator.userAgent);

  return (
    <div className="space-y-2">
      <p className="m-0 text-xs font-medium text-foreground">{t('providerPage.program.pin.title', { name: pinKey })}</p>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('providerPage.program.pin.description', { name: pinKey })}</p>
      {program.pin !== null && program.path === null ? (
        <p className="m-0 break-all text-xs text-amber-700 dark:text-amber-300">{t('binariesSettings.brokenPin', { path: program.pin })}</p>
      ) : null}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || unchanged) return;
          void work(() => pinBinary(pinKey, trimmed), t('binariesSettings.saved', { name: program.name }));
        }}
      >
        <label htmlFor={inputId} className="sr-only">{t('binariesSettings.pathLabel', { name: pinKey })}</label>
        <Input
          id={inputId}
          className="h-8 min-w-[16rem] flex-1 text-xs"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('binariesSettings.placeholder', { example })}
          disabled={busy}
          aria-invalid={error !== null}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => { setDraft(event.target.value); setError(null); }}
        />
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => void browse()}>
          <FolderOpen className="h-3.5 w-3.5" aria-hidden />
          {t('binariesSettings.browse')}
        </Button>
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={busy || !trimmed || unchanged}>
          {t('binariesSettings.save')}
        </Button>
        {program.pin !== null ? (
          <Button
            type="button" size="sm" variant="ghost" className="h-8 text-xs" disabled={busy}
            onClick={() => void work(() => unpinBinary(pinKey), t('binariesSettings.cleared', { name: program.name }))}
          >
            {t('binariesSettings.clear')}
          </Button>
        ) : null}
      </form>
      {error ? <p id={`${inputId}-error`} className="m-0 text-xs text-destructive" role="alert">{error}</p> : null}
      {dialog}
    </div>
  );
}

/** A provider installed from the agents catalog: its build, kept up to date (or repaired) from here. */
function CatalogAgent({ name, agent }: { name: string; agent: NonNullable<ProviderOverview['catalogAgent']> }): ReactElement {
  const page = useProviderPage();
  const [busy, setBusy] = useState(false);
  const broken = agent.state === 'tampered' || agent.state === 'missing';
  const offered = broken || agent.updateAvailable;

  const reinstall = async (): Promise<void> => {
    setBusy(true);
    try {
      await installAcpAgent(agent.id);
      toast.success(t('providerPage.program.catalog.updated', { name }));
      await page?.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProviderSettingRow
      data-catalog-agent={agent.id}
      title={t('providerPage.program.versionTitle')}
      status={broken
        ? <TonePill tone={agent.state === 'tampered' ? 'blocked' : 'action'} className="flex">{t(`providerPage.program.catalog.state.${agent.state}`)}</TonePill>
        : <span className="tabular-nums">{t('providerPage.program.catalog.installed', { version: agent.version })}</span>}
      action={offered ? (
        <Button type="button" size="sm" variant={broken ? 'default' : 'outline'} className="h-8 gap-1.5" disabled={busy} onClick={() => void reinstall()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowUpCircle className="size-3.5" aria-hidden />}
          {busy
            ? t('providerPage.program.installing')
            : broken
              ? t('providerPage.program.catalog.repair')
              : agent.latest
                ? t('providerPage.program.catalog.updateTo', { version: agent.latest })
                : t('providerPage.program.update')}
        </Button>
      ) : null}
    />
  );
}
