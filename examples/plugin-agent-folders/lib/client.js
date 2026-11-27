import React from 'react'
import { Button, cn, createTranslator, useAgentFolders } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    title: 'Extra folders', add: 'Add a folder', empty: 'No folder outside the working folder.',
    project: 'Project {name}', read: 'Read', write: 'Read and write', remove: 'Remove {name}',
    switch: 'Give {name} {access}', retry: 'Try again', failed: 'The folders could not be read.', target: 'Add to',
  },
  fr: {
    title: 'Dossiers supplémentaires', add: 'Ajouter un dossier', empty: 'Aucun dossier hors du dossier de travail.',
    project: 'Projet {name}', read: 'Lecture', write: 'Lecture et écriture', remove: 'Retirer {name}',
    switch: 'Donner à {name} : {access}', retry: 'Réessayer', failed: 'Les dossiers n’ont pas pu être lus.', target: 'Ajouter à',
  },
})

const ownerKey = (owner) => (owner.kind === 'agent' ? `agent:${owner.name}` : `project:${owner.slug}`)
const ownerLabel = (owner) => (owner.kind === 'agent' ? owner.name : t('project', { name: owner.slug }))

/**
 * A replacement of the agent folders section: one list per owner (the
 * project first, then each agent), a read/write switch on every folder.
 *
 * `agent.folders` is a `single` slot declared at boot, whose default occupant
 * is the product's section. Registering here claims it on both screens that
 * show it — the Workspace tab of the agent's page and the project's settings;
 * removing the plugin gives the product's back.
 *
 * The component receives no props: it reads `useAgentFolders()`. The host
 * reads and writes the lists, announces each change and owns the folder
 * browser; the plugin only paints and calls the gestures. Each gesture
 * resolves `{ ok: true }` or `{ ok: false, message }`: the daemon checks
 * every path again and says why it refuses (a credential folder, the Timon
 * home, a relative path), so show that message.
 */
function FoldersByOwner() {
  const host = useAgentFolders()
  const [refusal, setRefusal] = React.useState(null)
  const [target, setTarget] = React.useState('')

  if (!host) return null
  if (host.status === 'loading') return React.createElement('section', { className: host.className, 'aria-busy': 'true' })
  if (host.status === 'error') {
    return React.createElement('section', { className: cn('flex items-center gap-2 text-sm', host.className) },
      React.createElement('span', { className: 'flex-1' }, t('failed')),
      React.createElement(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => void host.reload() }, t('retry')))
  }

  const answer = (result) => setRefusal(result.ok ? null : result.message)
  const owner = host.owners.find((o) => ownerKey(o) === target) ?? host.owners[0]
  const add = async () => {
    if (!owner) return
    const path = await host.browse('')
    if (path) answer(await host.add(owner, { path, mode: 'read' }))
  }

  // One group per owner that holds a folder, in the host's order (the project first).
  const groups = []
  for (const row of host.rows) {
    const key = ownerKey(row.owner)
    let group = groups.find((g) => g.key === key)
    if (!group) groups.push(group = { key, owner: row.owner, rows: [] })
    group.rows.push(row)
  }

  const folder = (row) => {
    const next = row.mode === 'write' ? 'read' : 'write'
    return React.createElement('li', { key: row.path, 'data-example-folder': row.path, className: 'flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5' },
      React.createElement('span', { className: 'min-w-0 flex-1 truncate text-sm', title: row.dropped ? `${row.path}\n${row.dropped}` : row.path }, row.name),
      React.createElement('button', {
        type: 'button',
        disabled: host.busy,
        'aria-pressed': row.mode === 'write',
        'aria-label': t('switch', { name: row.name, access: t(next) }),
        onClick: async () => answer(await host.setMode(row.owner, row.path, next)),
        className: cn('rounded-full px-2 py-0.5 text-xs', row.mode === 'write' ? 'bg-primary/15 text-foreground' : 'bg-muted text-muted-foreground'),
      }, t(row.mode)),
      React.createElement('button', {
        type: 'button',
        disabled: host.busy,
        'aria-label': t('remove', { name: row.name }),
        title: t('remove', { name: row.name }),
        onClick: async () => answer(await host.remove(row.owner, row.path)),
        className: 'rounded-md px-1.5 text-sm text-muted-foreground hover:text-foreground',
      }, '×'))
  }

  return React.createElement('section', { className: cn('space-y-3', host.className), 'data-example-agent-folders': '' },
    React.createElement('div', { className: 'flex items-center gap-2' },
      React.createElement('h3', { className: 'flex-1 text-sm font-medium' }, t('title')),
      host.owners.length > 1 ? React.createElement('select', {
        'aria-label': t('target'),
        value: owner ? ownerKey(owner) : '',
        onChange: (e) => setTarget(e.target.value),
        className: 'h-7 rounded-md bg-muted px-2 text-xs',
      }, host.owners.map((o) => React.createElement('option', { key: ownerKey(o), value: ownerKey(o) }, ownerLabel(o)))) : null,
      host.owners.length > 0 ? React.createElement(Button, { type: 'button', size: 'sm', variant: 'ghost', disabled: host.busy, onClick: () => void add() }, t('add')) : null),
    refusal ? React.createElement('p', { role: 'alert', lang: 'en', className: 'text-xs text-amber-700 dark:text-amber-400' }, refusal) : null,
    groups.length === 0
      ? React.createElement('p', { className: 'rounded-xl bg-card px-3 py-2 text-sm text-muted-foreground' }, host.emptyStatus ?? t('empty'))
      : groups.map((group) => React.createElement('div', { key: group.key, className: 'rounded-xl bg-card p-1' },
        host.showAgent || group.owner.kind === 'project'
          ? React.createElement('div', { className: 'px-2 pt-1 text-xs text-muted-foreground' }, ownerLabel(group.owner))
          : null,
        React.createElement('ul', null, group.rows.map(folder)))))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  ctx.slots.register({ slot: 'agent.folders' }, FoldersByOwner)
}
