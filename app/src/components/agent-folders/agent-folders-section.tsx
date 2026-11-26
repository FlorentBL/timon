'use client';

/**
 * An agent's extra folders (`extra_dirs`), or those of a project and of every
 * agent in it: the folders outside the working directory their missions may
 * read, or read and write. Painted on the agent's page (Workspace tab) and in
 * the project's settings, from the same data (`lib/agent-folders.ts`). A
 * project's own folders (TODO #1168) reach every agent of the project.
 *
 * A short label with "Add a folder" at its right, then a card of rows: the
 * folder's name, and its access below. The full path is never painted on the
 * row: it shows in a hover title and at the top of the row's "…" menu, beside
 * every other gesture. A folder is added through a dialog; no field stays on
 * the page. A change applies from the agent's next mission: the fence is set
 * when a mission's process starts.
 *
 * `AgentFoldersSection` is the host that reads and writes the lists;
 * `ProductAgentFolders` the product's painting, default occupant of the
 * `agent.folders` slot, which reads the host's context (`useAgentFolders()`)
 * like any replacement would.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AlertTriangle, Copy, Lock, PenLine, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import { copyToClipboard } from '@/lib/clipboard';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { AGENT_FOLDERS_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import {
  addFolder, AgentFoldersError, fetchFolders, folderName, folderOwnerKey, isAbsoluteFolder, removeFolder,
  type AgentFolder, type AgentFolderMode, type AgentFolders, type FolderOwner,
} from '@/lib/agent-folders';
import {
  AgentFoldersProvider, useAgentFolders, type AgentFolderRow, type AgentFoldersResult, type AgentFoldersValue,
} from './agent-folders-context';

/** Who a row or a choice of the dialog names: the agent, or the whole project. */
function ownerLabel(owner: FolderOwner): string {
  return owner.kind === 'agent' ? owner.name : t('agentFolders.projectOwner', { project: owner.slug });
}

export type AgentFoldersSectionProps = {
  /** The agents whose folders are listed: one on an agent's page, every agent of a project on its settings. */
  agents: readonly string[];
  /** The project whose own folders are listed first, on its settings. */
  project?: string | null;
  /** Name the agent on each row: the project's list mixes several. */
  showAgent?: boolean;
  /** The row shown when no agent has a folder. */
  emptyStatus?: string;
  /** Called after each change, with every agent's folders. */
  onChanged?: (folders: readonly AgentFolders[]) => void;
  className?: string;
};

/**
 * The host: reads the lists, runs the gestures and announces each change, then
 * hands all of it to the occupant through `useAgentFolders()`. A person who may
 * not read the agents gets nothing painted.
 */
export function AgentFoldersSection({ agents, project = null, showAgent = false, emptyStatus, onChanged, className }: AgentFoldersSectionProps): ReactElement | null {
  const [lists, setLists] = useState<AgentFolders[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const picker = useDirectoryPicker();
  // An empty slot (a page the bundled halves do not reach) still gets the product's section.
  const claimed = useSlotEntries(AGENT_FOLDERS_SLOT).length > 0;
  // `key` stands for `agents` and `project`: a new array of the same names must not reload.
  const key = `${project ?? ''}\n${agents.join('\n')}`;
  const named = useRef(agents);
  named.current = agents;
  const owners = useMemo<FolderOwner[]>(() => [
    ...(project ? [{ kind: 'project' as const, slug: project }] : []),
    ...named.current.map((name) => ({ kind: 'agent' as const, name })),
  ], [key]);

  const load = useCallback(async () => {
    if (owners.length === 0) {
      setLists([]);
      setStatus('ready');
      return;
    }
    try {
      const agentLists = await Promise.all(owners.filter((o) => o.kind === 'agent').map((owner) => fetchFolders(owner)));
      // A person who may read the agents but not the project still sees the agents' folders.
      const projectOwner = owners.find((o) => o.kind === 'project');
      const projectList = projectOwner ? await fetchFolders(projectOwner).catch(() => null) : null;
      setLists([...(projectList ? [projectList] : []), ...agentLists]);
      setStatus('ready');
    } catch (err) {
      setStatus(err instanceof AgentFoldersError && (err.status === 401 || err.status === 403) ? 'forbidden' : 'error');
    }
  }, [owners]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo<AgentFolderRow[]>(() => (lists ?? []).flatMap((list) => list.folders.map((folder) => ({
    owner: list.owner,
    path: folder.path,
    name: folderName(folder.path),
    mode: folder.mode,
    dropped: list.dropped.find((d) => d.path === folder.path)?.reason ?? null,
  }))), [lists]);
  const writable = useMemo(() => (lists ?? []).map((list) => list.owner), [lists]);

  const apply = (next: AgentFolders): void => {
    const updated = (lists ?? []).map((list) => (folderOwnerKey(list.owner) === folderOwnerKey(next.owner) ? next : list));
    setLists(updated);
    onChanged?.(updated);
    toast.success(t(next.owner.kind === 'project'
      ? 'agentFolders.savedProject'
      : next.running > 0 ? 'agentFolders.savedNextMission' : 'agentFolders.saved'));
  };

  /** Runs a write; its refusal goes back to the occupant, which shows it where it fits. */
  const run = async (gesture: () => Promise<AgentFolders>): Promise<AgentFoldersResult> => {
    setBusy(true);
    try {
      apply(await gesture());
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      setBusy(false);
    }
  };

  if (status === 'forbidden') return null;
  const value: AgentFoldersValue = {
    agents,
    project,
    showAgent,
    emptyStatus: emptyStatus ?? null,
    className,
    status,
    rows,
    owners: writable,
    busy,
    reload: load,
    add: (owner, folder) => run(() => addFolder(owner, folder)),
    setMode: (owner, path, mode) => run(() => addFolder(owner, { path, mode })),
    remove: (owner, path) => run(() => removeFolder(owner, path)),
    browse: async (current) => {
      const picked = await picker.pick(current);
      if (picked.status === 'chosen') return picked.path;
      reportDirectoryPick(picked);
      return null;
    },
  };

  return (
    <AgentFoldersProvider value={value}>
      {claimed ? <SlotSingle name={AGENT_FOLDERS_SLOT} /> : <ProductAgentFolders />}
      {picker.dialog}
    </AgentFoldersProvider>
  );
}

/** The product's section, as the default occupant. Takes no props: it reads the host. */
export function ProductAgentFolders(): ReactElement | null {
  const host = useAgentFolders();
  const [adding, setAdding] = useState(false);
  if (!host) return null;
  const { status, rows, owners, busy, className, showAgent } = host;
  if (status === 'loading') return <section className={className} aria-busy="true" />;
  const title = t('agentFolders.section');
  const refused = (result: AgentFoldersResult): void => {
    if (!result.ok) toast.error(result.message);
  };

  return (
    <ProviderSection
      title={title}
      className={className}
      actions={status === 'ready' && owners.length > 0 ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 text-[12px]" disabled={busy} onClick={() => setAdding(true)} data-agent-folders-add="">
          <Plus aria-hidden className="size-3.5" />{t('agentFolders.add')}
        </Button>
      ) : null}
    >
      {status === 'error' ? (
        <ProviderSettingRow title={t('agentFolders.loadError')} action={
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void host.reload()}>{t('agentFolders.retry')}</Button>
        } />
      ) : rows.length === 0 ? (
        <ProviderSettingRow title={t('agentFolders.emptyTitle')} status={host.emptyStatus ?? t('agentFolders.emptyStatus')} data-agent-folders-empty="" />
      ) : rows.map(({ owner, path, name, mode, dropped }) => {
        const access = t(mode === 'write' ? 'agentFolders.mode.write' : 'agentFolders.mode.read');
        return (
          <ProviderSettingRow
            key={`${folderOwnerKey(owner)}\n${path}`}
            data-agent-folder={path}
            title={<span className="truncate" title={path}>{name}</span>}
            status={dropped ? (
              <span className="flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-400" title={`${path}\n${dropped}`}>
                <AlertTriangle aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{t('agentFolders.dropped')}</span>
              </span>
            ) : (
              <span className="block truncate" title={path}>
                {[...(showAgent || owner.kind === 'project' ? [ownerLabel(owner)] : []), access].join(' · ')}
              </span>
            )}
            menuLabel={t('agentFolders.more', { name })}
            menu={<>
              <DropdownMenuLabel className="max-w-72 break-all text-xs font-normal text-muted-foreground" data-agent-folder-path="">
                {path}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => {
                void copyToClipboard(path).then((copied) => {
                  if (copied) toast.success(t('agentFolders.pathCopied'));
                  else toast.error(t('agentFolders.copyFailed'));
                });
              }}>
                <Copy aria-hidden />{t('agentFolders.copyPath')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => void host.setMode(owner, path, mode === 'write' ? 'read' : 'write').then(refused)}>
                {mode === 'write' ? <Lock aria-hidden /> : <PenLine aria-hidden />}
                {t(mode === 'write' ? 'agentFolders.makeRead' : 'agentFolders.makeWrite')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} variant="destructive" onSelect={() => void host.remove(owner, path).then(refused)}>
                <Trash2 aria-hidden />{t('agentFolders.remove')}
              </DropdownMenuItem>
            </>}
          />
        );
      })}
      {adding && (
        <AddFolderDialog
          owners={owners}
          browse={host.browse}
          onCancel={() => setAdding(false)}
          onAdd={async (owner, folder, onError) => {
            const result = await host.add(owner, folder);
            if (result.ok) setAdding(false);
            else onError(result.message);
          }}
        />
      )}
    </ProviderSection>
  );
}

/** The dialog that adds one folder: for whom (on a project: the project or one agent), the path, the access. */
function AddFolderDialog({ owners, browse: browseFolder, onCancel, onAdd }: {
  owners: readonly FolderOwner[];
  browse: (current: string) => Promise<string | null>;
  onCancel: () => void;
  onAdd: (owner: FolderOwner, folder: AgentFolder, onError: (message: string) => void) => Promise<void>;
}): ReactElement {
  const [ownerKey, setOwnerKey] = useState(owners[0] ? folderOwnerKey(owners[0]) : '');
  const owner = owners.find((o) => folderOwnerKey(o) === ownerKey) ?? null;
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<AgentFolderMode>('read');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const absolute = isAbsoluteFolder(path);

  const browse = async (): Promise<void> => {
    const picked = await browseFolder(path);
    if (picked !== null) {
      setPath(picked);
      setRefusal(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-lg" data-agent-folders-dialog="">
        <DialogHeader>
          <DialogTitle>{t('agentFolders.dialog.title')}</DialogTitle>
          <DialogDescription>{t('agentFolders.dialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {owners.length > 1 && (
            <label className="block space-y-1">
              <span className="text-[12px] font-medium">{t(owners.some((o) => o.kind === 'project') ? 'agentFolders.dialog.owner' : 'agentFolders.dialog.agent')}</span>
              <Select value={ownerKey} onValueChange={setOwnerKey}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {owners.map((o) => <SelectItem key={folderOwnerKey(o)} value={folderOwnerKey(o)}>{ownerLabel(o)}</SelectItem>)}
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
            type="button" size="sm" disabled={busy || !owner || !absolute}
            onClick={async () => {
              if (!owner) return;
              setBusy(true);
              try {
                await onAdd(owner, { path: path.trim(), mode }, setRefusal);
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
