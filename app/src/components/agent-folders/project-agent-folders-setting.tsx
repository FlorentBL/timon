'use client';

/**
 * The project's row of `project.settings`: the extra folders of the project
 * itself (TODO #1168) and of its agents, counted on the row, listed and
 * edited in a dialog (`AgentFoldersSection`). One place to see what every
 * agent of the project may reach outside its working folder.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useProjectSettings } from '@/components/project-settings-slot';
import { t } from '@/lib/i18n';
import { fetchFolders, type AgentFolders } from '@/lib/agent-folders';
import { AgentFoldersSection } from './agent-folders-section';

type ListedAgent = { name: string; project?: string | null; ephemeral?: boolean; extra_dirs?: unknown[] };

/** The project's agents and how many folders they and the project hold, from the agents list and the project's own. */
async function projectAgents(project: string): Promise<{ names: string[]; folders: number } | null> {
  try {
    const res = await fetch('/api/ui/agents', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: ListedAgent[] };
    const agents = (body.agents ?? []).filter((a) => a.project === project && a.ephemeral !== true);
    const own = await fetchFolders({ kind: 'project', slug: project }).then((l) => l.folders.length).catch(() => 0);
    return {
      names: agents.map((a) => a.name).sort((a, b) => a.localeCompare(b)),
      folders: own + agents.reduce((n, a) => n + (Array.isArray(a.extra_dirs) ? a.extra_dirs.length : 0), 0),
    };
  } catch {
    return null;
  }
}

export function ProjectAgentFoldersSetting(): ReactElement | null {
  const settings = useProjectSettings();
  const project = settings?.project ?? null;
  const [state, setState] = useState<{ names: string[]; folders: number } | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    setState(project ? await projectAgents(project) : null);
  }, [project]);
  useEffect(() => { void reload(); }, [reload]);

  // The folders belong to the project: the row stays without an agent, to prepare one before the first.
  if (!project || !state) return null;
  const onChanged = (lists: readonly AgentFolders[]): void => {
    setState((current) => current && { ...current, folders: lists.reduce((n, l) => n + l.folders.length, 0) });
  };

  return (
    <div data-project-agent-folders={project} className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">{t('agentFolders.project.title')}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {state.folders === 0
            ? t('agentFolders.project.none')
            : t('agentFolders.project.summary', { count: state.folders })}
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
        {t('agentFolders.project.manage')}
      </Button>
      {open && (
        <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <DialogContent className="max-h-[min(720px,calc(100dvh-3rem))] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{t('agentFolders.project.dialogTitle', { project })}</DialogTitle>
              <DialogDescription>{t('agentFolders.project.dialogDescription')}</DialogDescription>
            </DialogHeader>
            <AgentFoldersSection
              agents={state.names}
              project={project}
              showAgent
              emptyStatus={t('agentFolders.project.emptyStatus')}
              onChanged={onChanged}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
