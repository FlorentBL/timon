// french-ok-file: the French locale of the warning under test
/**
 * The agent editor shows what the daemon answers to a save about the agent's
 * permissions (`warnings` of `POST /api/agents`): a whole-shell pre-allow the
 * claude CLI drops in auto mode, or may drop when no mode is set. The CLI and
 * the MCP already printed it; the editor dropped it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { agentSaveWarnings } from './agent-save-warnings';
import { getLocale, setLocale } from './i18n';
import './i18n-test-locales';
import { waitUntil } from './test-wait';

const ENGLISH = 'Zeus pre-allows Bash but sets no permission mode: the claude CLI then starts in the default mode of its own settings (permissions.defaultMode), and where that is auto it ignores a rule that allows every shell command. To keep the rule, set the agent\'s mode to acceptEdits; or pre-allow narrower patterns such as Bash(git:*).';
const ANSWER = {
  name: 'Zeus',
  warnings: [ENGLISH],
  warning_messages: [{ code: 'agent_shell_preallow_mode_unset', params: { agent: 'Zeus', rules: 'Bash' } }],
};

test('the warnings are read in the reader\'s language, and a malformed answer reads as none', () => {
  const previous = getLocale();
  try {
    setLocale('en');
    assert.deepEqual(agentSaveWarnings(ANSWER), [ENGLISH]);
    setLocale('fr');
    const [french] = agentSaveWarnings(ANSWER);
    assert.match(french!, /^Zeus pré-autorise Bash mais ne fixe aucun mode de permission/);
    // A code this screen does not know, or none at all: the daemon's English.
    assert.deepEqual(agentSaveWarnings({ warnings: ['plain'], warning_messages: [{ code: 'no_such_code', params: {} }] }), ['plain']);
    assert.deepEqual(agentSaveWarnings({ warnings: ['plain'] }), ['plain']);
    assert.deepEqual(agentSaveWarnings({ warnings: 'x', warning_messages: 3 }), []);
    assert.deepEqual(agentSaveWarnings({ warnings: [1, 'kept'] }), ['kept']);
    assert.deepEqual(agentSaveWarnings(null), []);
  } finally {
    setLocale(previous);
  }
});

test('saving an agent shows its warnings on the Permissions tab, and a quiet save clears them', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'DocumentFragment'] as const) {
    install(key, dom.window[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  // The CommonJS copy of sonner: the one the compiled component resolves.
  const { toast } = createRequire(join(process.cwd(), 'package.json'))('sonner') as typeof import('sonner');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const previousLocale = getLocale();
  setLocale('en');

  const warned: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  const succeeded: string[] = [];
  t.mock.method(toast, 'warning', ((message: string, options?: { action?: { label: string; onClick: () => void } }) => {
    warned.push({ message, action: options?.action });
    return 1;
  }) as typeof toast.warning);
  t.mock.method(toast, 'success', ((message: string) => { succeeded.push(message); return 1; }) as typeof toast.success);

  let saveAnswer: Record<string, unknown> = ANSWER;
  let saves = 0;
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/agents' && init?.method === 'POST') {
      saves += 1;
      return Response.json(saveAnswer);
    }
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'Zeus' }] });
    if (url === '/api/ui/agents/Zeus') return Response.json({ name: 'Zeus', config: { allowed_tools: ['Bash'] } });
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [], backends: [] });
  });

  const root = createRoot(document.getElementById('root')!);
  const panel = () => document.querySelector('[data-agent-save-warnings]');
  const save = async () => {
    const before = saves;
    await React.act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save')!.click();
    });
    await waitUntil(React.act, () => saves === before + 1, 'the save reached the daemon');
  };
  try {
    await React.act(async () => {
      root.render(React.createElement(AgentEditorModal));
      openAgentEditor({ agent: 'Zeus' });
    });
    await waitUntil(React.act, () => document.querySelector<HTMLInputElement>('[role="tabpanel"] input')?.value === 'Zeus', 'editor shows the agent');
    await save();
    await waitUntil(React.act, () => warned.length === 1, 'the save warns');
    assert.equal(warned[0]!.message, 'Zeus saved, with a warning about its permissions');
    assert.deepEqual(succeeded, [], 'a save that warns is not announced as a plain success');
    assert.equal(panel(), null, 'the detail lives on the Permissions tab');

    await React.act(async () => { warned[0]!.action!.onClick(); });
    await waitUntil(React.act, () => panel() !== null, 'the toast opens the Permissions tab');
    assert.equal(panel()!.getAttribute('role'), 'alert');
    assert.equal(panel()!.textContent, ENGLISH);

    saveAnswer = { name: 'Zeus' };
    warned.length = 0;
    await save();
    await waitUntil(React.act, () => panel() === null, 'a quiet save clears the warnings');
    assert.deepEqual(warned, []);
    assert.deepEqual(succeeded, ['Zeus saved']);
  } finally {
    await React.act(async () => { closeAgentEditor(); root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
