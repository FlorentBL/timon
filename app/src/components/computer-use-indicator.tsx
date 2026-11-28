'use client';

/**
 * The banner that tells a person an agent is steering their mouse and
 * keyboard, with the stop button. Mounted once at the root; it paints nothing
 * while no agent is in control, and polls lightly (the desktop pushes no event).
 * A stopped state stays visible with a resume button: a stop that left no trace
 * would leave the person wondering why the agent went quiet.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MousePointer2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { fetchComputerStatus, sendComputerControl, type ComputerStatus } from '@/lib/computer-use';

const POLL_ACTIVE_MS = 2_000;
const POLL_IDLE_MS = 10_000;

export function ComputerUseBanner({
  status,
  busy,
  onStop,
  onResume,
}: {
  status: ComputerStatus;
  busy: boolean;
  onStop: () => void;
  onResume: () => void;
}): React.ReactElement | null {
  if (!status.active && !status.stopped) return null;
  const stopped = status.stopped;
  return (
    <div
      role="status"
      data-computer-use-banner={stopped ? 'stopped' : 'active'}
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-amber-500/15 px-3.5 py-2.5 text-[12.5px] text-amber-900 shadow-lg backdrop-blur dark:text-amber-100"
    >
      <MousePointer2 className="size-4 shrink-0" aria-hidden />
      <span>{stopped ? t('computerIndicator.stoppedTitle') : t('computerIndicator.title')}</span>
      {stopped ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={onResume}>
          {t('computerIndicator.resume')}
        </Button>
      ) : (
        <Button size="sm" variant="destructive" disabled={busy} onClick={onStop}>
          {t('computerIndicator.stop')}
        </Button>
      )}
    </div>
  );
}

export function ComputerUseIndicator(): React.ReactElement | null {
  const [status, setStatus] = useState<ComputerStatus>({ active: false, stopped: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // A hidden window needs no banner; skip the call, not the schedule.
      const next = document.visibilityState === 'hidden' ? null : await fetchComputerStatus();
      if (cancelled) return;
      // The desktop reports `stopped` itself, so a reload keeps the Resume button.
      if (next) setStatus(next);
      timer = setTimeout(tick, next?.active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const control = useCallback(async (command: 'stop' | 'resume') => {
    setBusy(true);
    const ok = await sendComputerControl(command);
    setBusy(false);
    if (!ok) {
      toast.error(t(command === 'stop' ? 'computerIndicator.stopFailed' : 'computerIndicator.resumeFailed'));
      return;
    }
    setStatus({ active: false, stopped: command === 'stop' });
  }, []);

  return (
    <ComputerUseBanner
      status={status}
      busy={busy}
      onStop={() => void control('stop')}
      onResume={() => void control('resume')}
    />
  );
}
