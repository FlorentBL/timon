'use client';

/**
 * How the agent drives the screen: in the foreground (pixels, mouse and keyboard) or in the
 * background (accessibility only, the person's screen, mouse and keyboard stay theirs).
 */
import React from 'react';
import { t } from '@/lib/i18n';

export type ComputerUseModeValue = 'foreground' | 'background';

const OPTIONS: { value: ComputerUseModeValue; label: string; hint: string }[] = [
  { value: 'foreground', label: 'editPage.computerModeForeground', hint: 'editPage.computerModeForegroundHint' },
  { value: 'background', label: 'editPage.computerModeBackground', hint: 'editPage.computerModeBackgroundHint' },
];

export function ComputerUseMode({
  value, onChange,
}: {
  value: ComputerUseModeValue;
  onChange: (next: ComputerUseModeValue) => void;
}): React.ReactElement {
  return (
    <div data-computer-use-mode className="mt-2 rounded-lg bg-muted/30 px-3.5 py-3" role="radiogroup" aria-label={t('editPage.computerMode')}>
      <div className="text-[13px] font-medium">{t('editPage.computerMode')}</div>
      {OPTIONS.map((option) => (
        <label key={option.value} className="mt-1.5 flex cursor-pointer items-start gap-2.5">
          <input
            type="radio"
            name="computer-use-mode"
            className="mt-0.5"
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            data-computer-use-mode-option={option.value}
          />
          <span className="leading-snug">
            <span className="block text-[12.5px] font-medium">{t(option.label)}</span>
            <span className="block text-[11.5px] text-muted-foreground">{t(option.hint)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
