'use client';

/**
 * An agent's extra folders (`extra_dirs`), or those of every agent of a
 * project: the folders outside the working directory their missions may
 * read, or read and write. Painted on the agent's page (Workspace tab) and in
 * the project's settings, from the same data (`lib/agent-folders.ts`).
 *
 * A short label with "Add a folder" at its right, then a card of rows: the
 * folder's name, its access and full path below, and every other gesture in
 * the row's "…" menu. A folder is added through a dialog; no field stays on
 * the page. A change applies from the agent's next mission: the fence is set
 * when a mission's process starts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import { t } from '@/lib/i18n';
import {
  addAgentFolder, AgentFoldersError, fetchAgentFolders, folderName, isAbsoluteFolder, removeAgentFolder,
  type AgentFolder, type AgentFolderMode, type AgentFolders,
} from '@/lib/agent-folders';

type Row = { agent: string; folder: AgentFolder; dropped: string | null };

export type AgentFoldersSectionProps = {
  /** The agents whose folders are listed: one on an agent's page, every agent of a project on its settings. */
  agents: readonly string[];
  /** Name the agent on each row: the project's list mixes several. */
  showAgent?: boolean;
  /** The row shown when no agent has a folder. */
  emptyStatus?: string;
  /** Called after each change, with every agent's folders. */
  onChanged?: (folders: readonly AgentFolders[]) => void;
  className?: string;
};

export function AgentFoldersSection({ agents, showAgent = false, emptyStatus, onChanged, className }: AgentFoldersSectionProps): ReactElement | null {
  const [lists, setLists] = useState<AgentFolders[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // `key` stands for `agents`: a new array of the same names must not reload.
  const key = agents.join('\n');
  const named = useRef(agents);
  named.current = agents;

  const load = useCallback(async () => {
    const agents = named.current;
    if (agents.length === 0) {
      setLists([]);
      setStatus('ready');
      return;
    }
    try {
      setLists(await Promise.all(agents.map((agent) => fetchAgentFolders(agent))));
      setStatus('ready');
    } catch (err) {
      setStatus(err instanceof AgentFoldersError && (err.status === 401 || err.status === 403) ? 'forbidden' : 'error');
    }
  }, [key]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo<Row[]>(() => (lists ?? []).flatMap((list) => list.folders.map((folder) => ({
    agent: list.agent,
    folder,
    dropped: list.dropped.find((d) => d.path === folder.path)?.reason ?? null,
  }))), [lists]);

  const apply = (next: AgentFolders): void => {
    const updated = (lists ?? []).map((list) => (list.agent === next.agent ? next : list));
    setLists(updated);
    onChanged?.(updated);
    toast.success(t(next.running > 0 ? 'agentFolders.savedNextMission' : 'agentFolders.saved'));
  };

  /** Runs a write; its refusal goes to `onError` when given (the dialog shows it), to a toast otherwise. */
  const run = async (gesture: () => Promise<AgentFolders>, onError?: (message: string) => void): Promise<boolean> => {
    setBusy(true);
    try {
      apply(await gesture());
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (onError) onError(message);
      else toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') return <section className={className} aria-busy="true" />;
  if (status === 'forbidden') return null;
  const title = t('agentFolders.section');

  return (
    <ProviderSection
      title={title}
      className={className}
      actions={status === 'ready' && agents.length > 0 ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 text-[12px]" disabled={busy} onClick={() => setAdding(true)} data-agent-folders-add="">
          <Plus aria-hidden className="size-3.5" />{t('agentFolders.add')}
        </Button>
      ) : null}
    >
      {status === 'error' ? (
        <ProviderSettingRow title={t('agentFolders.loadError')} action={
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void load()}>{t('agentFolders.retry')}</Button>
        } />
      ) : rows.length === 0 ? (
        <ProviderSettingRow title={t('agentFolders.emptyTitle')} status={emptyStatus ?? t('agentFolders.emptyStatus')} data-agent-folders-empty="" />
      ) : rows.map(({ agent, folder, dropped }) => {
        const access = t(folder.mode === 'write' ? 'agentFolders.mode.write' : 'agentFolders.mode.read');
        return (
          <ProviderSettingRow
            key={`${agent}\n${folder.path}`}
            data-agent-folder={folder.path}
            title={<span className="truncate" title={folder.path}>{folderName(folder.path)}</span>}
            status={dropped ? (
              <span className="flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-400" title={dropped}>
                <AlertTriangle aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{t('agentFolders.dropped', { path: folder.path })}</span>
              </span>
            ) : (
              <span className="block truncate" title={folder.path}>
                {[...(showAgent ? [agent] : []), access, folder.path].join(' · ')}
              </span>
            )}
            menuLabel={t('agentFolders.more', { name: folderName(folder.path) })}
            menu={<>
              <DropdownMenuItem disabled={busy} onSelect={() => void run(() => addAgentFolder(agent, { path: folder.path, mode: folder.mode === 'write' ? 'read' : 'write' }))}>
                {t(folder.mode === 'write' ? 'agentFolders.makeRead' : 'agentFolders.makeWrite')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} className="text-destructive focus:bg-destructive/10 focus:text-destructive" onSelect={() => void run(() => removeAgentFolder(agent, folder.path))}>
                {t('agentFolders.remove')}
              </DropdownMenuItem>
            </>}
          />
        );
      })}
      {adding && (
        <AddFolderDialog
          agents={agents}
          onCancel={() => setAdding(false)}
          onAdd={async (agent, folder, onError) => {
            if (await run(() => addAgentFolder(agent, folder), onError)) setAdding(false);
          }}
        />
      )}
    </ProviderSection>
  );
}

/** The dialog that adds one folder: which agent (on a project), the path, the access. */
function AddFolderDialog({ agents, onCancel, onAdd }: {
  agents: readonly string[];
  onCancel: () => void;
  onAdd: (agent: string, folder: AgentFolder, onError: (message: string) => void) => Promise<void>;
}): ReactElement {
  const [agent, setAgent] = useState(agents[0] ?? '');
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<AgentFolderMode>('read');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const picker = useDirectoryPicker();
  const absolute = isAbsoluteFolder(path);

  const browse = async (): Promise<void> => {
    const picked = await picker.pick(path);
    if (picked.status === 'chosen') {
      setPath(picked.path);
      setRefusal(null);
    } else reportDirectoryPick(picked);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-lg" data-agent-folders-dialog="">
        <DialogHeader>
          <DialogTitle>{t('agentFolders.dialog.title')}</DialogTitle>
          <DialogDescription>{t('agentFolders.dialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {agents.length > 1 && (
            <label className="block space-y-1">
              <span className="text-[12px] font-medium">{t('agentFolders.dialog.agent')}</span>
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {agents.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-[12px] font-medium">{t('agentFolders.dialog.path')}</span>
            <div className="flex gap-1.5">
              <Input
                value={path}
                spellCheck={false}
                autoFocus
                aria-invalid={path.trim() !== '' && !absolute}
                placeholder={t('agentFolders.dialog.pathPlaceholder')}
                onChange={(event) => { setPath(event.target.value); setRefusal(null); }}
              />
              <Button type="button" variant="outline" className="shrink-0" onClick={() => void browse()}>{t('agentFolders.dialog.browse')}</Button>
              {picker.dialog}
            </div>
            {refusal && (
              <span role="alert" className="flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400" lang="en">
                <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />{refusal}
              </span>
            )}
            {path.trim() !== '' && !absolute && (
              <span role="alert" className="block text-[12px] text-amber-700 dark:text-amber-400">{t('agentFolders.dialog.notAbsolute')}</span>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium">{t('agentFolders.dialog.access')}</span>
            <Select value={mode} onValueChange={(value) => setMode(value as AgentFolderMode)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="read">{t('agentFolders.mode.read')}</SelectItem>
                <SelectItem value="write">{t('agentFolders.mode.write')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t('agentFolders.dialog.cancel')}</Button>
          <Button
            type="button" size="sm" disabled={busy || !agent || !absolute}
            onClick={async () => {
              setBusy(true);
              try {
                await onAdd(agent, { path: path.trim(), mode }, setRefusal);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('agentFolders.dialog.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
