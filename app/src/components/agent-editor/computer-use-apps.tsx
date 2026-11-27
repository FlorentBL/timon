'use client';

/**
 * The applications an agent may click and type in while computer use is on. The list is explicit:
 * an empty one lets the agent do nothing with the keyboard or the mouse, which the card says.
 * "Add from open windows" asks the desktop for the open windows and offers their applications.
 */
import React, { useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { fetchComputerWindows } from '@/lib/computer-use';

/** Distinct applications of the open windows, in the order the system lists them, minus those already allowed. */
export function appsToOffer(windows: readonly { app: string }[], allowed: readonly string[]): string[] {
  const known = new Set(allowed.map((app) => app.trim().toLowerCase()));
  const offered: string[] = [];
  for (const { app } of windows) {
    const name = app.trim();
    const key = name.toLowerCase();
    if (!name || known.has(key)) continue;
    known.add(key);
    offered.push(name);
  }
  return offered;
}

export function ComputerUseApps({
  values, onChange, load = fetchComputerWindows,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  /** The open windows; injected by tests. */
  load?: typeof fetchComputerWindows;
}): React.ReactElement {
  const [text, setText] = useState('');
  const [offer, setOffer] = useState<string[] | null>(null);
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = (app: string) => {
    const name = app.trim();
    if (name && !values.some((v) => v.toLowerCase() === name.toLowerCase())) onChange([...values, name]);
  };

  const fromWindows = async () => {
    setBusy(true);
    const windows = await load();
    setBusy(false);
    setNone(windows === null || windows.length === 0);
    setOffer(windows ? appsToOffer(windows, values) : []);
  };

  return (
    <div data-computer-use-apps className="mt-2 rounded-lg bg-muted/30 px-3.5 py-3">
      <div className="text-[13px] font-medium">{t('editPage.computerApps')}</div>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t('editPage.computerAppsHint')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-background/60 p-2">
        {values.map((app) => (
          <span key={app} data-computer-app className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[12px]">
            {app}
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v !== app))}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('editPage.computerAppsRemove', { app })}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(text); setText(''); }
            else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
          }}
          placeholder={t('editPage.computerAppsAdd')}
          aria-label={t('editPage.computerApps')}
          className="min-w-[160px] flex-1 border-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {values.length === 0 && (
        <p role="note" data-computer-use-apps-empty className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t('editPage.computerAppsEmptyWarning')}</span>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void fromWindows()} data-computer-use-apps-load>
          {t('editPage.computerAppsFromWindows')}
        </Button>
      </div>
      {offer !== null && offer.length > 0 && (
        <div data-computer-use-apps-offer className="mt-2">
          <p className="text-[11.5px] text-muted-foreground">{t('editPage.computerAppsFromWindowsHint')}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {offer.map((app) => (
              <button
                key={app}
                type="button"
                data-computer-app-offer
                onClick={() => { add(app); setOffer(offer.filter((o) => o !== app)); }}
                className="rounded-md bg-muted px-2 py-1 text-[12px] hover:bg-accent"
              >
                {app}
              </button>
            ))}
          </div>
        </div>
      )}
      {offer !== null && offer.length === 0 && (
        <p data-computer-use-apps-none className="mt-2 text-[11.5px] text-muted-foreground">
          {t(none ? 'editPage.computerAppsNoWindows' : 'editPage.computerAppsAllListed')}
        </p>
      )}
      <p className="mt-2 text-[11.5px] text-muted-foreground">{t('editPage.computerAppsScreenshot')}</p>
    </div>
  );
}
