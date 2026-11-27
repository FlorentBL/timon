'use client';

import { useState, type ReactElement } from 'react';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  GLASS_BLUR_RANGE, GLASS_FLOOR_RANGE, GLASS_TRANSPARENCY_RANGE, GLASS_ZONES,
  glassTuningOf, hslTripleToHex,
  type GlassTuning, type GlassZone, type NativeAppearance,
} from './ui-theme-variants';

type Tab = 'general' | GlassZone;
const TABS: readonly Tab[] = ['general', ...GLASS_ZONES];

/** What a picker that holds no tint yet starts from: the surface the zone replaces. */
const SURFACE_OF: Record<Tab, { dark: string; light: string }> = {
  general: { dark: '220 10% 13.5%', light: '0 0% 100%' },
  chrome: { dark: '220 12% 3.5%', light: '220 12% 89%' },
  islands: { dark: '220 12% 11%', light: '220 14% 97%' },
  widgets: { dark: '220 10% 13.5%', light: '0 0% 100%' },
  bubbles: { dark: '220 10% 13.5%', light: '0 0% 100%' },
};

const BUTTON = 'rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60';

function TuningControls({ tab, tuning, disabled, scheme, onChange, onReset }: {
  tab: Tab;
  tuning: GlassTuning;
  disabled: boolean;
  scheme: 'dark' | 'light';
  onChange: (patch: Partial<GlassTuning>) => void;
  onReset: (patch: Partial<GlassTuning>) => void;
}): ReactElement {
  const id = `glass-${tab}`;
  return (
    <div className={cn('flex flex-col gap-3', disabled && 'pointer-events-none opacity-60')}>
      <label className="flex flex-col gap-1 text-[13px] leading-snug">
        <span className="flex items-center justify-between gap-3">{t('appearance.glassBlur')}<span className="tabular-nums text-[12px] text-muted-foreground">{tuning.blur} px{/* i18n-exempt: unit symbol */}</span></span>
        <input id={`${id}-blur`} type="range" min={GLASS_BLUR_RANGE.min} max={GLASS_BLUR_RANGE.max} value={tuning.blur} disabled={disabled} onChange={(e) => onChange({ blur: Number(e.target.value) })} className="w-full accent-primary" />
      </label>
      <label className="flex flex-col gap-1 text-[13px] leading-snug">
        <span className="flex items-center justify-between gap-3">{t('appearance.glassTransparency')}<span className="tabular-nums text-[12px] text-muted-foreground">{tuning.transparency} %</span></span>
        <input id={`${id}-transparency`} type="range" min={GLASS_TRANSPARENCY_RANGE.min} max={GLASS_TRANSPARENCY_RANGE.max} value={tuning.transparency} disabled={disabled} onChange={(e) => onChange({ transparency: Number(e.target.value) })} className="w-full accent-primary" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2.5 text-[13px]">
          <input
            type="color"
            value={tuning.tint ?? hslTripleToHex(SURFACE_OF[tab][scheme])}
            disabled={disabled}
            onChange={(e) => onChange({ tint: e.target.value })}
            aria-label={t('appearance.glassTint')}
            className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
          />
          {t('appearance.glassTint')}
        </label>
        {tuning.tint && <button type="button" disabled={disabled} onClick={() => onReset({ tint: null })} className={BUTTON}>{t('appearance.glassTintReset')}</button>}
        {(tuning.blur !== GLASS_BLUR_RANGE.default || tuning.transparency !== GLASS_TRANSPARENCY_RANGE.default) && <button
          type="button"
          disabled={disabled}
          onClick={() => onReset({ blur: GLASS_BLUR_RANGE.default, transparency: GLASS_TRANSPARENCY_RANGE.default })}
          className={BUTTON}
        >
          {t('appearance.glassTuningReset')}
        </button>}
      </div>
    </div>
  );
}

/**
 * The glass of each zone, as a settings card: one row for General, then one
 * for Frame, Islands, Widgets and Bubbles (each following General until its
 * switch says otherwise), then the readability floor under the zones that
 * carry text. A row shows its value; its sliders unfold under it on "Adjust",
 * one row at a time, in place rather than in a dialog so the glass stays in
 * sight while it is dragged. Writes go through the Appearance screen's own
 * preview and reset, so a drag repaints through inline properties and the
 * row is written once.
 */
export function GlassTuningSettings({ native, disabled, scheme, onPreview, onReset }: {
  native: NativeAppearance;
  disabled: boolean;
  scheme: 'dark' | 'light';
  onPreview: (patch: Partial<NativeAppearance>) => void;
  onReset: (patch: Partial<NativeAppearance>) => void;
}): ReactElement {
  const [open, setOpen] = useState<Tab | 'floor' | null>(null);
  const generalPatch = (patch: Partial<GlassTuning>): Partial<NativeAppearance> => ({
    ...('blur' in patch ? { glassBlur: patch.blur } : {}),
    ...('transparency' in patch ? { glassTransparency: patch.transparency } : {}),
    ...('tint' in patch ? { glassTint: patch.tint ?? null } : {}),
  });
  const zonePatch = (zone: GlassZone, patch: Partial<GlassTuning> | null): Partial<NativeAppearance> => {
    const zones = { ...native.glassZones };
    if (patch === null) delete zones[zone];
    else zones[zone] = { ...glassTuningOf(native, zone), ...patch };
    return { glassZones: zones };
  };
  const toggle = (row: Tab | 'floor') => setOpen((current) => (current === row ? null : row));
  const adjust = (row: Tab | 'floor') => (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-8"
      disabled={disabled}
      aria-expanded={open === row}
      onClick={() => toggle(row)}
      data-glass-adjust={row}
    >
      {open === row ? t('appearance.glassTuningClose') : t('appearance.glassTuningAdjust')}
    </Button>
  );
  return (
    <ProviderSection title={t('appearance.glassTuningTitle')} className="mt-6">
      {TABS.map((id) => {
        const follows = id !== 'general' && !native.glassZones[id];
        const tuning = glassTuningOf(native, id);
        return (
          <ProviderSettingRow
            key={id}
            data-glass-zone={id}
            data-glass-own={id !== 'general' && !follows ? '' : undefined}
            title={t(`appearance.glassZones.${id}`)}
            status={follows ? t('appearance.glassZoneFollows') : <TuningStatus tuning={tuning} />}
            action={adjust(id)}
          >
            {open === id && !disabled && <div className="flex max-w-xl flex-col gap-3">
              {id !== 'general' && <label className="flex cursor-pointer items-center gap-3">
                <Switch checked={follows} onCheckedChange={(on) => onReset(zonePatch(id, on ? null : {}))} />
                <span className="text-[13px] leading-snug">{t('appearance.glassZoneFollow')}</span>
              </label>}
              <TuningControls
                tab={id}
                tuning={tuning}
                disabled={follows}
                scheme={scheme}
                onChange={(patch) => onPreview(id === 'general' ? generalPatch(patch) : zonePatch(id, patch))}
                onReset={(patch) => onReset(id === 'general' ? generalPatch(patch) : zonePatch(id, patch))}
              />
            </div>}
          </ProviderSettingRow>
        );
      })}
      <ProviderSettingRow
        data-glass-zone="floor"
        title={t('appearance.glassFloor')}
        status={native.glassFloor === 0 ? t('appearance.glassFloorOff') : `${native.glassFloor} %`}
        action={adjust('floor')}
      >
        {open === 'floor' && !disabled && <label className="flex max-w-xl flex-col gap-1">
          <span className="sr-only">{t('appearance.glassFloor')}</span>
          <input id="glass-floor" type="range" min={GLASS_FLOOR_RANGE.min} max={GLASS_FLOOR_RANGE.max} value={native.glassFloor} onChange={(e) => onPreview({ glassFloor: Number(e.target.value) })} className="w-full accent-primary" />
        </label>}
      </ProviderSettingRow>
    </ProviderSection>
  );
}

/** A zone's own values on one line: blur, transparency, and a swatch when it carries a colour. */
function TuningStatus({ tuning }: { tuning: GlassTuning }): ReactElement {
  return (
    <span className="flex items-center gap-1.5 tabular-nums">
      {t('appearance.glassTuningStatus', { blur: tuning.blur, transparency: tuning.transparency })}
      {tuning.tint && <span aria-label={t('appearance.glassTint')} className="size-3 rounded-sm" style={{ background: tuning.tint }} />}
    </span>
  );
}
