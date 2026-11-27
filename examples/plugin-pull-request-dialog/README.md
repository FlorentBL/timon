# plugin-pull-request-dialog

Replaces a pull request's detail window (slot `kanban.pull.dialog`), opened by
a click on its row in the Pull requests widget, with a compact one: where the
pull request stands, its checks one line each — the end of a failed check's
log on demand — and its gestures, the one its state calls for filled, a few
beside it, the rest in a "…" menu. The product's window comes back as soon as
the plugin is removed.

The component takes no props: it reads `usePullRequestDialog()` from
`@timon/ui` (client API 20) and draws the whole window with `Dialog`. It holds
no access to GitHub or to the daemon: the page, the check log and the diff are
read by the host, `refresh()` reads the page again, and `run(id)` goes through
the widget that opened the window, as from the row's menu. A gesture the host
marks `blocked` stays, greyed, with its reason. What a replacement must
respect is in [Slots](../../public-docs/docs/plugins/slots.md), under
`kanban.pull.dialog`.

The package deliberately ships no `SIGNATURE` file.
