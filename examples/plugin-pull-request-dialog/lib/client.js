import React from 'react'
import {
  Button, Dialog, DialogContent, DialogDescription, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  cn, createTranslator, usePullRequestDialog,
} from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    title: '#{number} {title}', loading: 'Reading the pull request…', refresh: 'Read it again', more: 'More gestures',
    open: 'Open', closed: 'Closed', merged: 'Merged', draft: 'Draft', into: '{head} into {base}',
    checks: 'Checks', noCheck: 'No check on this commit.', log: 'Read the log of {name}', logEmpty: 'The log is empty.',
    pass: 'Passed', fail: 'Failed', pending: 'Running', skipped: 'Skipped',
    job: 'Open the job', close: 'Close',
    resolveConflict: 'Resolve the conflict…', updateBranch: 'Update the branch', review: 'Prepare the review',
    report: 'Read the review', askContributor: 'Ask the contributor', comment: 'Comment', forge: 'Open on GitHub',
    not_allowed: 'This branch cannot be written from here.', fork_deleted: 'The fork was deleted.',
    branch_busy: 'Another branch gesture is running.', review_running: 'A review is running.',
  },
  fr: {
    title: 'n° {number} {title}', loading: 'Lecture de la pull request…', refresh: 'Relire', more: 'Autres gestes',
    open: 'Ouverte', closed: 'Fermée', merged: 'Fusionnée', draft: 'Brouillon', into: '{head} vers {base}',
    checks: 'Contrôles', noCheck: 'Aucun contrôle sur ce commit.', log: 'Lire le journal de {name}', logEmpty: 'Le journal est vide.',
    pass: 'Réussi', fail: 'Échoué', pending: 'En cours', skipped: 'Ignoré',
    job: 'Ouvrir le job', close: 'Fermer',
    resolveConflict: 'Résoudre le conflit…', updateBranch: 'Mettre à jour la branche', review: 'Préparer la relecture',
    report: 'Lire la relecture', askContributor: 'Écrire au contributeur', comment: 'Commenter', forge: 'Ouvrir sur GitHub',
    not_allowed: 'Cette branche ne peut pas être écrite d’ici.', fork_deleted: 'Le fork a été supprimé.',
    branch_busy: 'Un autre geste sur la branche est en cours.', review_running: 'Une relecture est en cours.',
  },
})

const DOT = { pass: 'bg-emerald-500', fail: 'bg-red-500', pending: 'bg-amber-500', skipped: 'bg-muted-foreground/40' }

/** One check, one line: its state, its name, and for a failure the end of its log on demand. */
function CheckRow({ check, readLog }) {
  const [log, setLog] = React.useState(null)
  const failed = check.status === 'fail' && check.url
  return React.createElement('li', { 'data-example-check': check.name, className: 'rounded-lg px-2 py-1' },
    React.createElement('div', { className: 'flex min-w-0 items-center gap-2 text-sm' },
      React.createElement('span', { className: cn('size-2 shrink-0 rounded-full', DOT[check.status]), title: t(check.status), 'aria-label': t(check.status) }),
      React.createElement('span', { className: 'min-w-0 flex-1 truncate', title: check.workflow ? `${check.workflow} / ${check.name}` : check.name }, check.name),
      failed ? React.createElement('button', {
        type: 'button',
        'aria-label': t('log', { name: check.name }),
        title: t('log', { name: check.name }),
        onClick: async () => setLog(await readLog(check.url)),
        className: 'rounded-md px-1.5 text-muted-foreground hover:text-foreground',
      }, '↧') : null),
    log ? React.createElement('p', { role: log.ok ? undefined : 'alert', className: 'mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 px-2 py-1 text-xs' },
      log.ok ? (log.value.tail || t('logEmpty')) : log.message) : null)
}

/**
 * A replacement of a pull request's detail window: where it stands, its
 * checks one line each, and its gestures.
 *
 * `kanban.pull.dialog` is a `single` slot declared at boot, whose default
 * occupant is the product's window (`fallback`). The component receives no
 * props: it reads its host with `usePullRequestDialog()` and draws the whole
 * window with `Dialog`. What a replacement must respect:
 *   - reach nothing itself: the page, the check log and the diff are read by
 *     the host, through the daemon; `refresh()` reads the page again;
 *   - run a gesture only from a person's click, through `run(id)`: Timon
 *     opens what it needs (a brief, the "Publish on GitHub" window, a
 *     conflict) and nothing reaches GitHub without that person's own
 *     confirmation there;
 *   - show a `blocked` gesture greyed, with its reason, rather than hide it;
 *   - call `close()` when the window is dismissed.
 * Every text of the page was written by someone on GitHub: React escapes it.
 */
function CompactPullRequest() {
  const host = usePullRequestDialog()
  if (!host) return null
  const { pull, load, actions } = host
  const page = load.kind === 'ready' ? load.page : null

  const gesture = (action, variant) => React.createElement(Button, {
    key: action.id,
    type: 'button',
    size: 'sm',
    variant,
    disabled: action.blocked !== null || action.busy,
    title: action.blocked ? t(action.blocked) : undefined,
    'data-example-gesture': action.id,
    onClick: () => host.run(action.id),
  }, t(action.id))

  const jobId = pull.links?.job_id ?? null
  const state = page ? (page.isDraft && page.state === 'open' ? t('draft') : t(page.state)) : null
  return React.createElement(Dialog, { open: true, onOpenChange: (open) => { if (!open) host.close() } },
    React.createElement(DialogContent, { className: 'flex max-h-[85vh] max-w-[560px] flex-col gap-3', 'data-example-pull': pull.number },
      React.createElement('div', { className: 'flex items-start gap-2' },
        React.createElement(DialogTitle, { className: 'min-w-0 flex-1' }, t('title', { number: pull.number, title: page?.title ?? pull.title })),
        React.createElement('button', {
          type: 'button',
          'aria-label': t('refresh'),
          title: t('refresh'),
          disabled: host.refreshing,
          onClick: () => void host.refresh(),
          className: 'rounded-md px-1.5 text-muted-foreground hover:text-foreground',
        }, '↻')),
      React.createElement(DialogDescription, null,
        page ? `${state} · ${t('into', { head: page.headRef, base: page.baseRef })}` : load.kind === 'error' ? load.message : t('loading')),
      page ? React.createElement('section', { className: 'min-h-0 overflow-auto rounded-xl bg-card p-1' },
        React.createElement('div', { className: 'px-2 pt-1 text-xs text-muted-foreground' }, t('checks')),
        page.checks.length === 0
          ? React.createElement('p', { className: 'px-2 py-1 text-sm text-muted-foreground' }, t('noCheck'))
          : React.createElement('ul', null, page.checks.map((check) => React.createElement(CheckRow, { key: check.name, check, readLog: host.readCheckLog })))) : null,
      React.createElement('div', { className: 'flex flex-wrap items-center justify-end gap-2' },
        jobId ? React.createElement(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: () => host.openJob(jobId) }, t('job')) : null,
        actions.overflow.length > 0 ? React.createElement(DropdownMenu, null,
          React.createElement(DropdownMenuTrigger, { asChild: true },
            React.createElement(Button, { type: 'button', size: 'sm', variant: 'ghost', 'aria-label': t('more'), title: t('more') }, '…')),
          React.createElement(DropdownMenuContent, { align: 'end' }, actions.overflow.map((action) => React.createElement(DropdownMenuItem, {
            key: action.id,
            disabled: action.blocked !== null || action.busy,
            title: action.blocked ? t(action.blocked) : undefined,
            onSelect: () => host.run(action.id),
          }, t(action.id))))) : null,
        actions.secondary.map((action) => gesture(action, 'outline')),
        actions.primary ? gesture(actions.primary, 'default') : null)))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  return ctx.slots.register({ slot: 'kanban.pull.dialog' }, CompactPullRequest)
}
