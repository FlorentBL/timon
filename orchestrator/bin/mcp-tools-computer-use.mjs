/**
 * MCP tool that asks the user to let an agent control their computer (CLI
 * `timon computer propose`).
 *
 * Nothing is granted from here. Widening `computer_use` or `computer_use_apps`
 * stays a person's decision: `computer_use_propose` raises a card in the
 * mission's conversation, the person allows or refuses it there, and the answer
 * comes back as a message. The daemon reads the mission from the token.
 */

export const tools = [
  {
    name: 'computer_use_propose',
    title: 'Ask to allow computer use',
    description:
      'Asks the user to let an agent control the computer (CLI `timon computer propose`): turn computer use on, add '
      + 'applications it may click and type in, or remove some. It changes nothing by itself: it shows a card in THIS '
      + 'conversation with the agent\'s current state and the state after, and only the user\'s click on Allow applies it '
      + '(the proposal expires after 24 hours). Their decision comes back to you as a message. Returns {status: "pending"}: '
      + 'never propose the same change twice. `agent` is the exact name from agent_list. Name an application as the user '
      + 'says it ("Discord") or, better, as the system names it (macOS bundle id `com.hnc.Discord`, Windows `Discord.exe`, '
      + 'Linux `discord`): the desktop accepts either. Each application is driven in the foreground (the user\'s screen, mouse and keyboard) or the background (accessibility only): the card shows the mode of each one. At most 20 applications per list, 200 characters each.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Exact name of the agent that would get the access (agent_list).' },
        addApps: {
          type: 'array', maxItems: 20,
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'object', properties: { app: { type: 'string' }, mode: { type: 'string', enum: ['foreground', 'background'] } }, required: ['app', 'mode'], additionalProperties: false },
            ],
          },
          description: 'Applications to allow: a name (the agent\'s default mode) or { app, mode } with mode "foreground" or "background". Native applications with a rich accessibility tree (TextEdit, Notes, Finder) can run in the background; games and canvas applications (Discord, browsers\' web pages, games) have an empty tree and need "foreground". Listing an application already allowed changes its mode.',
        },
        removeApps: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Applications to stop allowing.' },
        enable: { type: 'boolean', description: 'true turns computer use on for the agent, false turns it off.' },
        note: { type: 'string', description: 'Plain text shown on the card: why (max 300 characters).' },
      },
      required: ['agent'],
      additionalProperties: false,
    },
  },
];

export const handlers = {
  async computer_use_propose(args, { call, env }) {
    if (!env.missionId) throw new Error('computer_use_propose only works inside a mission (TIMON_MISSION_ID is not set)');
    const body = {};
    for (const key of ['agent', 'addApps', 'removeApps', 'enable', 'note']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const r = await call('POST', '/api/computer/proposals', body);
    return { id: r.id, status: r.status, message: r.message };
  },
};
