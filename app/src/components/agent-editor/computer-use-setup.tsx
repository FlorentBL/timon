'use client';

/**
 * The setup card under the Computer use switch: one line per prerequisite the
 * desktop reports (✅/❌), the "Allow" button that triggers the macOS prompts,
 * and the exact steps where the system cannot be asked. It refreshes itself
 * while something is missing, so the person sees each line turn green as they
 * grant it, without leaving Timon.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import {
  COMPUTER_CHECK_KEYS, COMPUTER_UNREACHABLE, fetchComputerSetup, requestComputerPermissions, restartComputerApp,
  type ComputerCheck, type ComputerCheckKey, type ComputerSetup,
} from '@/lib/computer-use';

const POLL_MS = 3_000;

/** The Settings path to follow when the direct link opens the wrong pane (not detectable, so always shown). */
const MAC_PATHS: Partial<Record<ComputerCheckKey, string>> = {
  accessibility: 'computerSetup.pathAccessibility',
  screen: 'computerSetup.pathScreen',
};

/** Whether anything still needs the person: drives the polling. */
export function setupIncomplete(setup: ComputerSetup): boolean {
  return !setup.reachable || setup.needsRestart || Object.values(setup.checks).some((state) => state !== 'ok');
}

function Line({ label, state, children }: { label: string; state: ComputerCheck; children?: React.ReactNode }): React.ReactElement {
  const ok = state === 'ok';
  return (
    <li data-computer-check-state={state} className="flex items-start gap-2 py-1">
      <div className="min-w-0 flex-1 leading-snug">
        <div className="text-[12.5px] font-medium">
          <span aria-hidden>{ok ? '✅' : '❌'}</span>
          <span className="sr-only">{t(ok ? 'computerSetup.stateOk' : 'computerSetup.stateMissing')}</span> {label}
        </div>
        {!ok && children}
      </div>
    </li>
  );
}

export function ComputerUseSetupView({
  setup, busy, onAllow, onRestart,
}: {
  setup: ComputerSetup;
  busy: boolean;
  onAllow: () => void;
  onRestart: () => void;
}): React.ReactElement {
  const mac = setup.platform === 'darwin';
  const rows = COMPUTER_CHECK_KEYS.filter((key) => setup.checks[key] !== undefined);
  const grantMissing = mac && (setup.checks.accessibility === 'missing' || setup.checks.screen === 'missing');
  return (
    <div data-computer-use-setup className="mt-2 rounded-lg bg-muted/30 px-3.5 py-3">
      <div className="text-[13px] font-medium">{t('computerSetup.title')}</div>
      <ul className="mt-1.5">
        {rows.map((key) => {
          const state = setup.checks[key]!;
          const path = mac ? MAC_PATHS[key] : undefined;
          const label = key === 'inputTool' ? t(mac ? 'computerSetup.inputToolMac' : 'computerSetup.inputToolLinux') : t(`computerSetup.${key}`);
          return (
            <Line key={key} label={label} state={state}>
              {key === 'desktop' && <p className="text-[11.5px] text-muted-foreground">{t(setup.reachable ? 'computerSetup.desktopNoScreen' : 'computerSetup.desktopHint')}</p>}
              {path && <p className="text-[11.5px] text-muted-foreground">{t('computerSetup.pathLead')} {t(path)}</p>}
              {key === 'inputTool' && !mac && (
                <div className="text-[11.5px] text-muted-foreground">
                  <p>{t('computerSetup.installXdotool')}</p>
                  <ul className="mt-0.5 space-y-0.5">
                    {['sudo apt install xdotool', 'sudo dnf install xdotool', 'sudo pacman -S xdotool'].map((command) => (
                      <li key={command}>
                        {/* code-font: shell command to copy */}
                        <code className="font-mono text-[11px]">{command}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {key === 'session' && <p className="text-[11.5px] text-muted-foreground">{t(state === 'unsupported' ? 'computerSetup.needX11' : 'computerSetup.noSession')}</p>}
            </Line>
          );
        })}
      </ul>
      {grantMissing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={onAllow} data-computer-use-allow>{t('computerSetup.allow')}</Button>
          <span className="text-[11.5px] text-muted-foreground">{t('computerSetup.allowHint')}</span>
        </div>
      )}
      {setup.needsRestart ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-computer-use-restart>
          <Button size="sm" variant="outline" disabled={busy} onClick={onRestart}>{t('computerSetup.restart')}</Button>
          <span className="text-[11.5px] text-muted-foreground">{t('computerSetup.restartHint')}</span>
        </div>
      ) : (
        setup.checks.screen === 'missing' && <p className="mt-2 text-[11.5px] text-muted-foreground">{t('computerSetup.restartMaybe')}</p>
      )}
      {setup.reachable && setup.available && !setup.needsRestart && (
        <p className="mt-2 text-[12px] text-emerald-700 dark:text-emerald-400" data-computer-use-ready>{t('computerSetup.ready')}</p>
      )}
    </div>
  );
}

export function ComputerUseSetup(): React.ReactElement {
  const [setup, setSetup] = useState<ComputerSetup>(COMPUTER_UNREACHABLE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // A hidden window needs no refresh; skip the call, not the schedule.
      const next = document.visibilityState === 'hidden' ? null : await fetchComputerSetup();
      if (cancelled) return;
      if (next) setSetup(next);
      // Light polling only while something is missing; a complete setup stops asking.
      if (!next || setupIncomplete(next)) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  const allow = useCallback(async () => {
    setBusy(true);
    const ok = await requestComputerPermissions();
    setBusy(false);
    if (!ok) { toast.error(t('computerSetup.allowFailed')); return; }
    setSetup(await fetchComputerSetup());
  }, []);

  const restart = useCallback(async () => {
    setBusy(true);
    const ok = await restartComputerApp();
    setBusy(false);
    if (!ok) toast.error(t('computerSetup.restartFailed'));
  }, []);

  return <ComputerUseSetupView setup={setup} busy={busy} onAllow={() => void allow()} onRestart={() => void restart()} />;
}
