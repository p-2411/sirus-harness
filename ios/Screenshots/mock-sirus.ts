// A stand-in Sirus for screenshots of the phone app. It speaks remote
// control protocol v1 (docs/superpowers/specs/2026-09-28-remote-control-design.md)
// on 127.0.0.1:47470 and serves the scene named by SCENE, filled with the
// awkward data real sessions produce: long unbroken names and paths, many
// agents, long tool titles and code lines, requests waiting on the user.
// `shoot.sh` starts one per scene; run it by hand with
// `SCENE=approval bun ios/Screenshots/mock-sirus.ts`.

type Frame = Record<string, unknown>;

const scene = process.env.SCENE ?? 'conversation';
const now = Date.now();

const LONG_NAME = 'Refactor-remote-control-session-ownership-so-two-terminal-windows-never-drive-one-session-at-the-same-time';
const LONG_DIRECTORY = '~/code/clients/very-long-organisation-name/monorepo/packages/remote-control-server-and-client/src/agent_runtime/permissions';
const LONG_PATH = 'ios/SirusRemote/Views/ConversationViewWithAVeryLongFileNameThatNeverBreaksAnywhereOnAPhoneScreen.swift';
const UNBROKEN = 'refactor-auth-oauth2/pkce.'.repeat(10);
const LONG_URL = 'https://developer.apple.com/documentation/swiftui/view/safeareabar(edge:alignment:spacing:content:)?language=swift&changes=latest_minor&platform=ios';

const sessions = [
  { id: 's-main', name: 'Float the phone’s menus over the conversation', directory: '~/code/sirus-harness', status: 'working', working: true, needsYou: false, lastActivity: now - 4_000, assistantVersion: 42 },
  { id: 's-long', name: LONG_NAME, directory: LONG_DIRECTORY, status: 'idle', working: false, needsYou: true, lastActivity: now - 90_000, assistantVersion: 7 },
  { id: 's-approval', name: 'Rebuild the simulator app from scratch', directory: '~/code/sirus-harness/ios', status: 'working', working: true, needsYou: true, lastActivity: now - 20_000, assistantVersion: 12 },
  { id: 's-question', name: 'Choose how pickers should look', directory: '~/code/sirus-harness', status: 'working', working: true, needsYou: true, lastActivity: now - 45_000, assistantVersion: 9 },
  { id: 's-crowded', name: 'Eight agents review the remote-control protocol before release', directory: '~/code/sirus-harness/docs/superpowers/specs', status: 'idle', working: false, needsYou: false, lastActivity: now - 3_600_000, assistantVersion: 30 },
  { id: 's-empty', name: 'New session', directory: '~/code/sirus-harness', status: 'idle', working: false, needsYou: false, lastActivity: now - 7_200_000, assistantVersion: 0 },
  { id: 's-stress', name: UNBROKEN.slice(0, 120), directory: `/Users/sebastian/${UNBROKEN}`.slice(0, 200), status: 'working', working: true, needsYou: true, lastActivity: now - 1_000, assistantVersion: 99 },
  { id: 's-error', name: 'Fix the flaky escape test', directory: '~/code/sirus-harness/tests/frontend', status: 'error', working: false, needsYou: false, lastActivity: now - 86_400_000, assistantVersion: 3 },
  ...Array.from({ length: 6 }, (_, index) => ({
    id: `s-old-${index}`, name: `Older session ${index + 1}: tidy the ${['changelog', 'README', 'push keys', 'setup screen', 'sidebar', 'caption'][index]}`,
    directory: '~/code/sirus-harness', status: 'idle', working: false, needsYou: false,
    lastActivity: now - (index + 2) * 86_400_000, assistantVersion: 1,
  })),
];

// The session each scene opens on, through `focus`, as the terminal's own
// focus would open it.
const focusSession: Record<string, string> = {
  conversation: 's-main', loading: 's-main', gone: 's-main', offline: 's-main',
  approval: 's-approval', question: 's-question', crowded: 's-crowded', empty: 's-empty', long: 's-long',
  stress: 's-stress',
};
// The agent each scene opens on: the stress scene opens on its widest name.
const focusParticipant = scene === 'stress' ? 'コードレビュー担当エージェント' : 'sirus';
const focusId = focusSession[scene] ?? 's-main';

const participants: Record<string, { name: string; model: string; vendor: string; working: boolean; needsYou: boolean }[]> = {
  default: [
    { name: 'sirus', model: 'claude-opus-4-1-20250805[1m]', vendor: 'Claude', working: true, needsYou: false },
    { name: 'codex', model: 'gpt-5-codex', vendor: 'Codex', working: false, needsYou: false },
    { name: 'reviewer', model: 'claude-sonnet-4-5', vendor: 'Claude', working: false, needsYou: false },
  ],
  crowded: [
    'sirus', 'codex', 'reviewer', 'security-auditor-for-the-remote-protocol', 'docs', 'ios-layout-checker', 'tester', 'release-manager',
  ].map((name, index) => ({ name, model: index % 2 ? 'gpt-5-codex' : 'claude-sonnet-4-5', vendor: index % 2 ? 'Codex' : 'Claude', working: index === 5, needsYou: index === 6 })),
  stress: [
    'sirus', 'security-auditor-for-the-remote-protocol', 'documentation-writer-for-every-endpoint', 'ios-layout-checker-at-three-sizes-and-up',
    'コードレビュー担当エージェント', '🦄🦄🦄🦄🦄🦄🦄🦄', 'release-manager-for-the-next-version', 'tester',
  ].map((name, index) => ({ name, model: 'claude-opus-4-1-20250805[1m]', vendor: 'Claude', working: index === 1, needsYou: index === 2 })),
};

function header(participant: string): Frame {
  const agents = scene === 'crowded' ? participants.crowded : scene === 'stress' ? participants.stress : participants.default.map(agent => ({
    ...agent,
    needsYou: (scene === 'approval' && agent.name === 'sirus') || (scene === 'question' && agent.name === 'sirus'),
  }));
  const working = scene !== 'empty' && scene !== 'crowded' && scene !== 'long';
  const thought = scene === 'approval' ? 'waiting for your approval'
    : scene === 'question' ? 'waiting for your answer'
    : '**Checking** how the floating overlay measures the header and the input bar, so that opening a menu never pushes the transcript up on a small phone';
  if (scene === 'stress') {
    return {
      participants: agents,
      status: { participant, thought: `**Reading** ${UNBROKEN}`.repeat(2), startedAt: now - 4_000_000 },
      queued: 12,
      permissionMode: 'bypass permissions',
      modeNotice: 'the reviewer is unavailable, so every tool call asks first',
      context: { text: 'ctx 196k · 2% left · /compact', tone: 'danger' },
      thinking: 'max',
    };
  }
  return {
    participants: agents,
    status: working && participant === 'sirus' ? { participant, thought, startedAt: now - 83_000 } : null,
    queued: scene === 'conversation' ? 2 : 0,
    permissionMode: 'ask for approval',
    modeNotice: scene === 'conversation' ? 'plan mode, edits need approval' : null,
    context: { text: scene === 'empty' ? 'ctx 3k (1%)' : 'ctx 184k · 8% left · /compact', tone: scene === 'empty' ? 'subtle' : 'warning' },
    thinking: 'high',
  };
}

const paragraph = (text: string) => ({ kind: 'paragraph', text });
const code = (text: string, language?: string) => ({ kind: 'code', text, ...(language ? { language } : {}) });
let rowNumber = 0;
const row = (kind: string, author: string, extra: Frame): Frame => ({ id: `row-${rowNumber++}`, kind, author, ...extra });
const tool = (title: string, state: string, detail: Frame[] = [], kind = 'edit') =>
  row('tool', 'sirus', { tool: { title, kind, state, detail } });

function transcript(participant: string): Frame[] {
  rowNumber = 0;
  if (scene === 'empty') return [];
  if (participant === 'codex') {
    return [
      row('user', 'you', { to: ['codex'], blocks: [paragraph(`@codex review \`${LONG_PATH}\` before I merge`)] }),
      row('assistant', 'codex', { blocks: [paragraph('Two things before this merges:'), { kind: 'list', ordered: true, items: [
        '`closePicker()` bumps the epoch on every agent switch, even with no picker up. That is fine, but the comment should say so.',
        `The toast can sit under the header while a picker is open; check it at ${LONG_URL}`,
      ] }] }),
    ];
  }
  return [
    row('compaction', 'sirus', { blocks: [paragraph('Earlier: the phone app was redesigned in Liquid Glass after the TUI, and the remote-control protocol gained the `/` and `@` menus.')] }),
    row('user', 'you', { to: [], blocks: [paragraph('The menus push the transcript up on the phone instead of floating over it. Can you fix that, and make the info under the message bar tappable?')] }),
    row('assistant', 'sirus', { blocks: [paragraph('I’ll start with where the menus are laid out.')] }),
    tool(`Read ${LONG_PATH}`, 'done', [], 'read'),
    tool('Search for `safeAreaBar` and `GlassEffectContainer` in ios/SirusRemote', 'done', [], 'search'),
    row('assistant', 'sirus', { blocks: [
      { kind: 'heading', level: 2, text: 'Why the transcript moves' },
      paragraph(`The completion menu and the picker are children of the bottom \`.safeAreaBar\`, so each one grows the bar, and the pinned transcript scrolls up by the same amount. Apple documents the bar at ${LONG_URL}.`),
      { kind: 'list', ordered: false, items: [
        'Move the menus into an `.overlay` placed from the measured `headerHeight`, `inputHeight` and `barHeight`.',
        'Hide the status line with opacity instead of removing it, so the bar keeps its height.',
        'Make the permission mode, model and thinking level open their pickers.',
      ] },
      { kind: 'quote', text: 'A menu in a bar would grow it and push the transcript up.' },
    ] }),
    tool(`Edit ${LONG_PATH}`, 'done', [code([
      '@@ -94,7 +94,9 @@ private struct Conversation: View {',
      '-            .safeAreaBar(edge: .bottom) { bottom.background { Fade(edge: .bottom) } }',
      '+            .safeAreaBar(edge: .bottom) { bottom.background { Fade(edge: .bottom) } }',
      '+            .overlay { floating }',
      '             .task(id: "\\(client.endpoint.port)/\\(sessionId)/\\(participant)") { await subscribe() }',
    ].join('\n'), 'diff')]),
    tool('Run xcodebuild build -project ios/SirusRemote.xcodeproj -scheme SirusRemote -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO', 'failed', [code(
      'error: no such module \'SwiftUI\'\nerror: xcodebuild is only available on macOS; this container runs Linux')], 'execute'),
    row('notice', 'sirus', { blocks: [paragraph('Model changed to claude-opus-4-1-20250805[1m]'), paragraph('Thinking stays at high')] }),
    row('assistant', 'sirus', { blocks: [
      paragraph('The build can’t run here, so the change goes to the macOS workflow. The floating layer is:'),
      code([
        'private var floating: some View {',
        '    ZStack(alignment: .bottom) {',
        '        if let picker { PickerCard(picker: picker, dismiss: closePicker, run: { try await send($0, from: .picker) }).padding(.top, headerHeight + 12) }',
        '    }',
        '}',
      ].join('\n'), 'swift'),
      paragraph('`ConversationView.floating.PickerCard.padding.top.headerHeight.plus.twelve.points.and.nothing.else` is the only offset it needs.'),
    ] }),
    tool('Run bun test tests/remote_push.test.ts', 'running', [], 'execute'),
  ];
}

function requests(): Frame[] {
  if (scene === 'stress') {
    const label = (text: string) => `${text}, ${'and remember this choice for every later command in this directory '.repeat(2)}`.slice(0, 110);
    return [{
      id: 'r-stress', kind: 'approval', requester: 'security-auditor-for-the-remote-protocol',
      title: `Run ${UNBROKEN}`.slice(0, 300),
      detail: [code(Array.from({ length: 60 }, (_, index) => `+ ${index} ${UNBROKEN}`).join('\n'), 'diff')],
      options: [
        { id: 'a', label: label('Yes'), kind: 'allow_once' },
        { id: 'b', label: label('Yes, always'), kind: 'allow_always' },
        { id: 'c', label: label('Yes, for this session'), kind: 'allow_always' },
        { id: 'd', label: label('No'), kind: 'reject_once' },
        { id: 'e', label: label('No, never'), kind: 'reject_always' },
        { id: 'f', label: label('No, and explain'), kind: 'reject_once' },
      ],
    }];
  }
  if (scene === 'approval') {
    return [{
      id: 'r-approval', kind: 'approval', requester: 'sirus',
      title: 'Run rm -rf ios/build/DerivedData && xcodebuild -project ios/SirusRemote.xcodeproj -scheme SirusRemote -destination "platform=iOS Simulator,name=iPhone SE (3rd generation)" build',
      detail: [code([
        'rm -rf ios/build/DerivedData',
        'xcodebuild -project ios/SirusRemote.xcodeproj -scheme SirusRemote -destination "platform=iOS Simulator,name=iPhone SE (3rd generation)" -derivedDataPath ios/build/DerivedData build',
        ...Array.from({ length: 14 }, (_, index) => `# step ${index + 1}: compile ios/SirusRemote/Views/${['ConversationView', 'PickerCard', 'Composer', 'Transcript', 'Sidebar', 'RootView', 'SetupView'][index % 7]}.swift`),
      ].join('\n'))],
      options: [
        { id: 'o-once', label: 'Yes', kind: 'allow_once' },
        { id: 'o-always', label: 'Yes, and don’t ask again for xcodebuild commands in ~/code/sirus-harness/ios', kind: 'allow_always' },
        { id: 'o-no', label: 'No, and tell Sirus what to do differently', kind: 'reject_once' },
      ],
    }, { id: 'r-approval-2', kind: 'approval', requester: 'codex', title: 'Edit ios/README.md', detail: [], options: [{ id: 'y', label: 'Yes', kind: 'allow_once' }] }];
  }
  if (scene === 'question') {
    return [{
      id: 'r-question', kind: 'question', requester: 'sirus',
      message: 'A few choices before I change the pickers.',
      fields: [
        { kind: 'choice', key: 'layout', title: 'Layout', description: 'Where should command pickers such as /model appear on the phone?', required: true, multiple: false,
          options: [
            { value: 'float', label: 'Float over the conversation', description: 'Appears in the input’s place; the transcript stays where it is' },
            { value: 'sheet', label: 'A bottom sheet', description: 'The system sheet, with a grabber and detents' },
            { value: 'inline', label: 'Inside the bottom bar, as now', description: 'Grows the bar, which pushes the transcript up' },
          ], other: { key: 'layout_other' } },
        { kind: 'boolean', key: 'haptics', title: 'Haptics', description: 'Play a light haptic when a menu opens?', required: false },
        { kind: 'number', key: 'rows', title: 'Rows', description: 'How many rows should the / menu show before it scrolls?', required: false, integer: true, minimum: 3, maximum: 8 },
        { kind: 'text', key: 'notes', title: 'Notes', description: 'Anything else I should know?', required: false },
      ],
    }];
  }
  return [];
}

function view(participant: string): Frame {
  return {
    type: 'view', sessionId: focusId, participant, reset: true,
    header: header(participant), rows: transcript(participant), removed: [],
    requests: participant === focusParticipant ? requests() : [],
  };
}

function sessionsFrame(): Frame {
  return {
    type: 'sessions',
    focus: scene === 'nosessions' ? null : { sessionId: focusId, participant: focusParticipant, at: now },
    sessions: scene === 'nosessions' ? [] : sessions,
  };
}

// What a command opens instead of running, in the terminal's order.
const pickers: Record<string, Frame> = {
  '/model': { title: '/model', entries: [
    { kind: 'heading', label: 'Claude' },
    { kind: 'item', label: 'Claude Opus 4.1 (1M context)', description: 'claude-opus-4-1-20250805[1m] · most capable, slower and uses your limits fastest', command: '/model claude-opus-4-1-20250805[1m]', current: true },
    { kind: 'item', label: 'Claude Sonnet 4.5', description: 'claude-sonnet-4-5 · fast, for everyday work', command: '/model claude-sonnet-4-5' },
    { kind: 'item', label: 'Claude Haiku 4.5', description: 'claude-haiku-4-5 · fastest', command: '/model claude-haiku-4-5' },
    { kind: 'heading', label: 'Codex' },
    { kind: 'item', label: 'gpt-5-codex', description: 'OpenAI’s coding model', command: '/model gpt-5-codex' },
    { kind: 'item', label: 'gpt-5', description: 'General purpose', command: '/model gpt-5' },
    { kind: 'info', label: 'Models your plan doesn’t include are hidden. Sign in with /login to see more.' },
    { kind: 'item', label: 'Another model…', description: 'Type a model id', command: '/model', prompt: { text: 'Model id', secret: false } },
  ] },
  '/thinking': { title: '/thinking', entries: ['off', 'low', 'medium', 'high', 'max'].map(level => ({
    kind: 'item', label: level, command: `/thinking ${level}`, current: level === 'high',
    ...(level === 'max' ? { description: 'Thinks longest; slower and uses more of your limits' } : {}),
  })) },
  '/permissions': { title: '/permissions', entries: [
    { kind: 'item', label: 'Ask for approval', description: 'Sirus asks before anything that edits files or runs commands', command: '/permissions ask' },
    { kind: 'item', label: 'Auto approve', description: 'The vendor’s own reviewer decides what needs you', command: '/permissions auto' },
    { kind: 'item', label: 'Bypass permissions', description: 'Nothing is asked. Only use this in a sandbox.', command: '/permissions bypass' },
  ] },
};

function send(text: string): Frame {
  const command = text.trim().split(/\s+/)[0] ?? '';
  if (text.trim() in pickers) return { ok: true, picker: pickers[text.trim()] };
  if (command === '/long-note') {
    return { ok: true, feedback: `Compacted the conversation. ${'Kept the plan, the open files and the last three decisions; dropped tool output older than an hour. '.repeat(6)}`.slice(0, 600) };
  }
  if (command === '/model' && text.includes('opus-9')) {
    return { ok: false, error: 'claude-opus-9 isn’t a model Sirus knows. Open /model to pick one, or check the id for typos.' };
  }
  if (command.startsWith('/')) return { ok: true, feedback: `Model changed to ${text.trim().split(/\s+/)[1] ?? 'claude-sonnet-4-5'} for @sirus. Thinking stays at high.` };
  return { ok: true };
}

// The menu for the `/` or `@` before the cursor, nearest match last.
function complete(text: string, cursor: number): Frame[] {
  const token = text.slice(0, cursor).split(/\s/).pop() ?? '';
  const start = cursor - token.length;
  if (token.startsWith('/')) {
    return [
      ['/mcp-servers-from-the-vendor-with-a-long-name', 'Manage the MCP servers this vendor loaded for the session, including ones from project settings', 'claude'],
      ['/review', 'Ask the agent to review the current changes', 'codex'],
      ['/compact', 'Summarise the conversation so far to free context'],
      ['/permissions', 'Choose what Sirus asks before running'],
      ['/thinking [level]', 'Set how hard the agent thinks'],
      ['/model [name] [thinking]', 'Choose the model for this agent, or set it directly'],
    ].map(([label, description, tag]) => ({
      kind: 'command', label, description, ...(tag ? { tag } : {}), start, end: cursor, insert: `${label.split(' ')[0]} `,
    }));
  }
  if (token.startsWith('@')) {
    return [
      { kind: 'directory', label: 'ios/SirusRemote/Connection/', description: '' },
      { kind: 'file', label: LONG_PATH, description: '' },
      { kind: 'file', label: 'ios/SirusRemote/Views/PickerCard.swift', description: '' },
      { kind: 'participant', label: '@reviewer', description: 'claude-sonnet-4-5' },
      { kind: 'participant', label: '@codex', description: 'gpt-5-codex' },
    ].map(item => ({ ...item, start, end: cursor, insert: `${item.label.startsWith('@') ? item.label : `@${item.label}`} ` }));
  }
  return [];
}

Bun.serve({
  hostname: '127.0.0.1',
  port: 47470,
  fetch(request, server) {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/hello') return Response.json({ protocol: 1, sirus: 'screenshots', pid: process.pid });
    if (pathname === '/v1/socket' && server.upgrade(request)) return undefined;
    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(socket) {
      socket.send(JSON.stringify(sessionsFrame()));
      // The session stops being remote controlled while it is on screen.
      if (scene === 'gone') {
        setTimeout(() => socket.send(JSON.stringify({ type: 'sessions', focus: null, sessions: sessions.filter(session => session.id !== focusId) })), 3000);
      }
    },
    message(socket, raw) {
      const frame = JSON.parse(String(raw)) as Frame;
      const reply = (extra: Frame) => socket.send(JSON.stringify({ type: 'result', id: frame.id, ...extra }));
      switch (frame.type) {
        case 'subscribe':
          reply({ ok: true });
          // Loading never gets its first view, so the app stays on it.
          if (scene !== 'loading') socket.send(JSON.stringify(view(String(frame.participant))));
          break;
        case 'send': reply(send(String(frame.text))); break;
        case 'complete': reply({ ok: true, items: complete(String(frame.text), Number(frame.cursor)) }); break;
        default: reply({ ok: true });
      }
    },
  },
});

console.log(`mock Sirus serving "${scene}" on 127.0.0.1:47470`);
