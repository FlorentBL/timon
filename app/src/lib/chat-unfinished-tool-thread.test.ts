/**
 * A call the previous turn left without a result (the process was killed, the
 * daemon restarted, the turn was cut) is over: when the next turn is prepared or
 * starts, the thread shows it interrupted, never running with a timer that keeps
 * counting from its old start (TODO #748). A call of the turn still running stays
 * running, even when a message is sent while it runs.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetAllChatMissions } from './chat-mission-cache';

afterEach(() => forgetAllChatMissions());

type Row = { id?: number; type: string; timestamp: number; payload: Record<string, unknown> };
const ev = (id: number, type: string, payload: Record<string, unknown>): Row => ({ id, type, timestamp: id * 10, payload });
const userSays = (id: number, text: string) => ev(id, 'user', { type: 'user', message: { content: text } });
const agentDoes = (id: number, ...content: unknown[]) => ev(id, 'assistant', { type: 'assistant', message: { content } });
const agentSays = (id: number, text: string) => agentDoes(id, { type: 'text', text });
/** A Bash call; its command names it in the indicator, so two calls tell apart. */
const agentRuns = (id: number) => agentDoes(id, { type: 'tool_use', id: `tool-${id}`, name: 'Bash', input: { command: `ls ${id}`, description: `Step ${id}` } });
const toolAnswers = (id: number, toolId: number) => ev(id, 'user', {
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool-${toolId}`, content: 'done' }] },
});
const turnEnds = (id: number) => ev(id, 'result', { type: 'result', subtype: 'success', result: 'ok' });

/** A turn whose Bash never got its result: the process died under it. */
const CUT_TURN = [userSays(1, 'run the build'), agentRuns(2)];

class FakeStream {
  static opened: FakeStream[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(readonly url: string) { FakeStream.opened.push(this); }
  addEventListener(kind: string, listener: (e: { data: string }) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }
  removeEventListener() {}
  close() { this.readyState = 2; }
  emit(kind: string, body: unknown) {
    for (const listener of this.listeners.get(kind) ?? []) listener({ data: JSON.stringify(body) });
  }
}

type Mission = { running?: boolean; turn_active: boolean; turn_preparing?: boolean; events: Row[] };

async function openChat(mission: Mission) {
  FakeStream.opened = [];
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?mission=m1', pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element',
    'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
    'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, dom.window[key]);
  install('CSS', { escape: (value: string) => value });
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  install('EventSource', FakeStream);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // The watchdog's 5 s round never fires here: these tests are about what is drawn.
  const realSetInterval = dom.window.setInterval.bind(dom.window);
  (dom.window as unknown as { setInterval: unknown }).setInterval = (run: () => void, ms: number) =>
    (ms === 5_000 ? 0 : realSetInterval(run, ms));

  const daemon = { turnActive: mission.turn_active, sent: [] as string[] };
  install('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/ui/missions?')) return Response.json({ missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: true }] });
    if (url.startsWith('/api/ui/missions/m1/send')) {
      daemon.sent.push(String(JSON.parse(init?.body ?? '{}').input));
      daemon.turnActive = true;
      return Response.json({ ok: true });
    }
    if (url.includes('view=status')) return Response.json({ turn_active: daemon.turnActive, turn_preparing: false });
    if (url.startsWith('/api/ui/missions/m1?')) return Response.json({ running: true, ...mission });
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatClient } = await import('../app/chat/chat-client');
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; compact?: boolean }>;
  const { getLocale, setLocale } = await import('./i18n');
  const locale = getLocale();
  setLocale('en');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: '/chat' },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('mission=m1') as never },
            React.createElement(WidgetHost, null, React.createElement(Chat, { forcedMission: 'm1', compact: true }))))),
    );
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await settle();

  const stream = () => {
    const newest = FakeStream.opened.at(-1);
    assert.ok(newest, 'a stream is open');
    return newest;
  };
  const rowFrame = (row: Row) => ({ kind: 'event', missionId: 'm1', type: row.type, timestamp: row.timestamp, payload: row.payload });
  const texts = (selector: string) => Array.from(document.querySelectorAll(selector)).map((n) => n.textContent ?? '');
  return {
    daemon,
    /** The agent is shown working (the composer's placeholder while a turn runs). */
    working: () => (document.querySelector('textarea')?.placeholder ?? '').includes('Enter steers the agent'),
    /** Calls drawn as in flight: the live rows of the stacked bubble and the bar
     *  above the composer both name them by what the agent said they are for. */
    running: () => [...texts('.tool-stack-live-what'), ...texts('span.truncate.font-medium.text-foreground')].filter((s) => /^Step \d+$/.test(s)),
    /** Chips drawn as cut short. */
    interrupted: () => document.querySelectorAll('.tool-chip-interrupted').length,
    text: () => document.body.textContent ?? '',
    async live(...rows: Row[]) {
      await React.act(async () => { for (const row of rows) stream().emit('event', rowFrame(row)); });
      await settle();
    },
    async missionEnds() {
      await React.act(async () => { stream().emit('mission_complete', { kind: 'mission_complete', missionId: 'm1', status: 'terminated' }); });
      await settle();
    },
    /** What the person types, then Ctrl+Enter. */
    async type(text: string) {
      const box = document.querySelector('textarea');
      assert.ok(box, 'the composer is there');
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
      await React.act(async () => {
        setValue.call(box, text);
        box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await React.act(async () => {
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      });
      await settle();
    },
    async close() {
      await React.act(async () => { root.unmount(); });
      setLocale(locale);
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test('a reload while the next turn is prepared shows the cut call interrupted, not running', async () => {
  const chat = await openChat({ running: false, turn_active: false, turn_preparing: true, events: CUT_TURN });
  try {
    assert.equal(chat.working(), true, 'the agent is shown at work: a turn is on its way');
    assert.deepEqual(chat.running(), [], 'nothing of the previous turn is in flight');
    assert.equal(chat.interrupted(), 1, 'the cut call says so');

    chat.daemon.turnActive = true;
    await chat.live(userSays(10, 'the message that was waiting'), agentSays(11, 'on it'));
    assert.deepEqual(chat.running(), [], 'nor once the new turn has started');

    await chat.live(agentRuns(12));
    assert.deepEqual(chat.running(), ['Step 12'], 'the new turn\'s own call runs');
    assert.equal(chat.interrupted(), 1);
  } finally {
    await chat.close();
  }
});

test('the tab that sends the next message does not bring the cut call back to life', async () => {
  const chat = await openChat({ turn_active: false, events: CUT_TURN });
  try {
    assert.equal(chat.working(), false);
    assert.equal(chat.interrupted(), 1);
    await chat.type('try again');
    assert.deepEqual(chat.daemon.sent, ['try again\n']);
    assert.equal(chat.working(), true);
    assert.deepEqual(chat.running(), []);
  } finally {
    await chat.close();
  }
});

test('a turn that ends with a call unanswered leaves it interrupted for the next one', async () => {
  const chat = await openChat({ turn_active: true, events: [userSays(1, 'run the build')] });
  try {
    await chat.live(agentRuns(2));
    assert.deepEqual(chat.running(), ['Step 2']);
    await chat.live(turnEnds(3));
    assert.equal(chat.interrupted(), 1);

    await chat.live(userSays(4, 'and now?'));
    assert.equal(chat.working(), true);
    assert.deepEqual(chat.running(), []);
  } finally {
    await chat.close();
  }

  const killed = await openChat({ turn_active: true, events: [userSays(1, 'run the build')] });
  try {
    await killed.live(agentRuns(2));
    await killed.missionEnds();
    assert.equal(killed.interrupted(), 1, 'a process that dies ends its calls too');
  } finally {
    await killed.close();
  }
});

test('a message sent while a call runs leaves that call running', async () => {
  const chat = await openChat({ turn_active: true, events: CUT_TURN });
  try {
    assert.deepEqual(chat.running(), ['Step 2'], 'the daemon says the turn is live: its call is in flight');
    assert.equal(chat.interrupted(), 0);

    await chat.live(userSays(3, 'also check the logs'));
    assert.deepEqual(chat.running(), ['Step 2'], 'a word from the person does not end the turn');
    assert.equal(chat.interrupted(), 0);

    await chat.live(toolAnswers(4, 2));
    assert.deepEqual(chat.running(), []);
    assert.equal(chat.interrupted(), 0);
  } finally {
    await chat.close();
  }
});

test('a result that comes after all takes the interrupted mark off', async () => {
  const chat = await openChat({ turn_active: false, events: [...CUT_TURN, turnEnds(3), toolAnswers(4, 2)] });
  try {
    assert.equal(chat.interrupted(), 0);
  } finally {
    await chat.close();
  }
});
