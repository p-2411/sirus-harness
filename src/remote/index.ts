import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import type { Session } from '../agent_runtime/session';
import { pendingApprovals, resolveApproval, subscribePermissions } from '../agent_runtime/permissions/approvals';
import { pendingQuestions, resolveQuestion, subscribeQuestions, type QuestionAnswer } from '../agent_runtime/permissions/questions';
import { commandMenu, executeCommand, type PromptCommand } from '../commands/registry';
import { commandArgs, commandsWait, queueDraft, queueInput, routeInput, splitDraft } from '../frontend/chat/send';
import { APNS_ENVIRONMENTS, openSettings } from '../persistence/settings';
import { SIRUS_VERSION } from '../version';
import { sessionEntry, viewOf } from './view';

// Remote control: the sessions this process has /rc on, served to the phone
// over Tailscale. One listener per process, on the Mac's own Tailscale
// address, never 0.0.0.0; a peer is let in only when Tailscale says its
// device belongs to the same user as this Mac. Everything else is protocol
// v1, as `docs/superpowers/specs/2026-09-28-remote-control-design.md` has it:
// `GET /v1/hello` to find the process, and one WebSocket, `/v1/socket`, for
// the rest. `SIRUS_REMOTE_LOOPBACK=1` binds 127.0.0.1 instead, skips
// Tailscale, and lets in loopback peers only: the smoke runs and the
// simulator use it.
//
// Tailscale vouches for devices, not for what runs on them: a web page open
// in a browser on one of the owner's devices reaches the listener from a
// trusted address. Browsers mark such requests with an Origin, and the app
// sends none, so any request with one is refused; the Host must name this
// Mac, which stops a page rebinding its own name to the listener.

const PORTS = { first: 47470, last: 47479 };
const LIST_THROTTLE_MS = 250;
const VIEW_THROTTLE_MS = 100;
const TAILSCALE_TIMEOUT_MS = 5_000;
// How long Tailscale's verdict on a peer holds, so a device probing the
// ports cannot make Sirus run `tailscale whois` for every request.
const VERDICT_MS = 60_000;
// The most phones kept for pushes.
const MAX_DEVICES = 10;
const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const loopback = () => process.env.SIRUS_REMOTE_LOOPBACK === '1';

interface Subscription {
  session: Session;
  participant: string;
  stop: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  // What the phone has of each row, as sent, and of the rest of the frame.
  rows: Map<string, string>;
  rest: string;
}

interface SocketData {
  ip: string;
  subscription: Subscription | null;
  // Commands the phone started on this socket, by session, so Stop on the
  // phone and a dropped connection can end them.
  running: Set<{ sessionId: string; controller: AbortController }>;
}

type Socket = ServerWebSocket<SocketData>;

interface Listener {
  server: ReturnType<typeof Bun.serve<SocketData, never>>;
  // The name the phone reaches this Mac by: its MagicDNS name.
  host: string;
  port: number;
  // The Tailscale user a peer's device must belong to.
  user: string;
}

// Every session of this process, remote or not, by id: /rc turns one on
// without the listener having to be told about it again.
const sessions = new Map<string, Session>();
const sockets = new Set<Socket>();
// Tailscale's verdict on each peer, for a minute; one with a socket open is
// let in without asking again.
const verdicts = new Map<string, { verdict: Promise<boolean>; at: number }>();
let listener: Listener | null = null;
let starting: Promise<Listener> | null = null;
let focus: { sessionId: string; participant: string; at: number } | null = null;
let listTimer: ReturnType<typeof setTimeout> | null = null;
let lastList = '';
let toldAboutPushes = false;

// ── Tailscale ────────────────────────────────────────────────────────────

function tailscale(args: string[]): Promise<string> {
  const binary = Bun.which('tailscale') ?? (existsSync(TAILSCALE_APP) ? TAILSCALE_APP : null);
  if (!binary) {
    return Promise.reject(new Error('Tailscale is not installed. Install it from tailscale.com/download, sign in, and try /rc again.'));
  }
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: TAILSCALE_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// This Mac on the tailnet: the address to bind, the name to hand the phone,
// and the user its peers must share.
async function tailnetSelf(): Promise<{ ip: string; host: string; user: string }> {
  if (loopback()) return { ip: '127.0.0.1', host: '127.0.0.1', user: '' };
  const notRunning = new Error('Tailscale is not running. Open Tailscale, connect, and try /rc again.');
  let status: { BackendState?: string; Self?: { TailscaleIPs?: string[]; UserID?: number; DNSName?: string } };
  try {
    status = JSON.parse(await tailscale(['status', '--json']));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Tailscale is not installed')) throw error;
    throw notRunning;
  }
  if (status.BackendState === 'NeedsLogin' || status.BackendState === 'NeedsMachineAuth') {
    throw new Error('Tailscale is logged out. Sign in to Tailscale and try /rc again.');
  }
  const ip = status.Self?.TailscaleIPs?.find(address => /^\d+\.\d+\.\d+\.\d+$/.test(address));
  if (status.BackendState !== 'Running' || !ip || status.Self?.UserID === undefined) throw notRunning;
  return { ip, host: status.Self.DNSName?.replace(/\.$/, '') || ip, user: String(status.Self.UserID) };
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// A peer is let in when its device belongs to this Mac's Tailscale user.
async function trusted(ip: string, user: string): Promise<boolean> {
  if (loopback()) return isLoopback(ip);
  try {
    const whois = JSON.parse(await tailscale(['whois', '--json', ip])) as { UserProfile?: { ID?: number } };
    return whois.UserProfile?.ID !== undefined && String(whois.UserProfile.ID) === user;
  } catch {
    return false;
  }
}

function allowed(ip: string, user: string): Promise<boolean> {
  if ([...sockets].some(socket => socket.data.ip === ip)) return Promise.resolve(true);
  const now = Date.now();
  const cached = verdicts.get(ip);
  if (cached && now - cached.at < VERDICT_MS) return cached.verdict;
  for (const [address, { at }] of verdicts) if (now - at >= VERDICT_MS) verdicts.delete(address);
  const verdict = trusted(ip, user);
  verdicts.set(ip, { verdict, at: now });
  return verdict;
}

// A request a browser made, or one for a name other than this Mac's.
function fromBrowser(request: Request, self: { ip: string; host: string }): boolean {
  if (request.headers.has('origin')) return true;
  const authority = request.headers.get('host')?.toLowerCase() ?? '';
  const name = (authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.replace(/:\d+$/, '')).replace(/\.$/, '');
  const host = self.host.toLowerCase();
  // The MagicDNS name, and the short name MagicDNS also answers to.
  const names = [self.ip, host, ...(host === self.ip ? [] : [host.split('.')[0]]), ...(loopback() ? ['localhost'] : [])];
  return !names.includes(name);
}

// ── What the phone is sent ───────────────────────────────────────────────

function remoteSessions(): Session[] {
  return [...sessions.values()].filter(session => session.isRemote());
}

function listFrame(): string {
  const available = remoteSessions();
  return JSON.stringify({
    type: 'sessions',
    focus: focus && available.some(session => session.getId() === focus!.sessionId) ? focus : null,
    sessions: available.map(sessionEntry),
  });
}

// The sessions list goes to every phone whenever it changes, at most every
// quarter second.
function listChanged(): void {
  if (listTimer || !sockets.size) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const frame = listFrame();
    if (frame === lastList) return;
    lastList = frame;
    for (const socket of sockets) socket.send(frame);
  }, LIST_THROTTLE_MS);
}

// The rows the phone does not have yet, or has an older version of, and
// those it should drop; everything on a reset. A change the phone would not
// see sends nothing.
function sendView(socket: Socket, reset = false): void {
  const subscription = socket.data.subscription;
  if (!subscription) return;
  const frame = viewOf(subscription.session, subscription.participant);
  const rows = new Map(frame.rows.map(row => [row.id, JSON.stringify(row)]));
  const rest = JSON.stringify([frame.header, frame.requests]);
  if (!reset) {
    frame.rows = frame.rows.filter(row => subscription.rows.get(row.id) !== rows.get(row.id));
    frame.removed = [...subscription.rows.keys()].filter(id => !rows.has(id));
    if (!frame.rows.length && !frame.removed.length && rest === subscription.rest) return;
  }
  frame.reset = reset;
  subscription.rows = rows;
  subscription.rest = rest;
  socket.send(JSON.stringify(frame));
}

function viewChanged(socket: Socket): void {
  const subscription = socket.data.subscription;
  if (!subscription || subscription.timer) return;
  subscription.timer = setTimeout(() => {
    subscription.timer = null;
    if (socket.data.subscription === subscription) sendView(socket);
  }, VIEW_THROTTLE_MS);
}

function unsubscribe(socket: Socket): void {
  const subscription = socket.data.subscription;
  if (!subscription) return;
  subscription.stop();
  if (subscription.timer) clearTimeout(subscription.timer);
  socket.data.subscription = null;
}

function subscribe(socket: Socket, session: Session, participant: string, rows = new Map<string, string>()): void {
  unsubscribe(socket);
  socket.data.subscription = { session, participant, rows, rest: '', timer: null, stop: session.subscribe(() => viewChanged(socket)) };
}

// Approvals and questions belong to no one session's change feed.
subscribePermissions(() => {
  listChanged();
  for (const socket of sockets) viewChanged(socket);
});
subscribeQuestions(() => {
  listChanged();
  for (const socket of sockets) viewChanged(socket);
});

// ── What the phone asks for ──────────────────────────────────────────────

type Frame = Record<string, unknown>;

// Text from the phone, taken as if typed into that participant's
// conversation in the terminal: the same commands, wherever they are
// written, and the same routing and queueing (`frontend/chat/send.ts`). What
// the commands and a reporting vendor command say comes back as feedback.
async function sendText(socket: Socket, session: Session, participant: string, text: string): Promise<string | undefined> {
  const draft = splitDraft(session, text, participant);
  if (commandsWait(session, draft)) {
    queueDraft(draft, [], (queued, images, content) => queueInput(session, queued, participant, images, content));
    return undefined;
  }
  const said: string[] = [];
  for (const command of draft.commands) {
    const output = await runCommand(socket, session, participant, command);
    if (output) said.push(output);
  }
  if (draft.prompt) {
    const output = await sendPrompt(socket, session, participant, draft.prompt);
    if (output) said.push(output);
  }
  return said.join('\n') || undefined;
}

// A controller for work the phone started, ended by Stop on the phone or by
// its socket closing.
async function tracked<T>(socket: Socket, session: Session, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const entry = { sessionId: session.getId(), controller: new AbortController() };
  socket.data.running.add(entry);
  try {
    return await work(entry.controller.signal);
  } finally {
    socket.data.running.delete(entry);
  }
}

async function runCommand(socket: Socket, session: Session, participant: string, command: PromptCommand): Promise<string | undefined> {
  const args = commandArgs(command.name, command.args, participant);
  const probe = new AbortController();
  const menu = commandMenu(command.name, args, session, probe.signal);
  probe.abort();
  if (menu) throw new Error(`/${command.name} ${args.length ? 'with these arguments ' : ''}opens a menu, which only the terminal can show.`);
  let progress: string | undefined;
  const outcome = await tracked(socket, session, signal => Promise.resolve(executeCommand(command.name, args, {
    session, participant, signal, argumentText: command.argumentText,
    notify: text => { progress = text; },
    sendPrompt: text => session.sendMessage(session.messageForParticipant({ role: 'user', to: [participant], content: [{ type: 'text', text }] }, participant)).then(() => undefined),
  })));
  if (outcome?.kind === 'error') throw new Error(outcome.text);
  return outcome ? outcome.text : progress;
}

// Text with no command of Sirus's left in it.
async function sendPrompt(socket: Socket, session: Session, participant: string, text: string): Promise<string | undefined> {
  const route = routeInput(session, text, participant);
  if (route.aside) {
    const { participant: target, text: invocation } = route.aside;
    const output = await tracked(socket, session, signal => session.runCommandAside(target, invocation, signal));
    return output.text || `@${target} printed nothing for ${invocation}.`;
  }
  if (route.busy && !route.immediate) {
    queueInput(session, text, participant);
    return undefined;
  }
  // The result says whether the message was taken, not how its turn went:
  // a refusal comes before the entry is added, synchronously, so it is the
  // rejection already waiting when the turn is looked at; a turn that fails
  // later says so in the conversation.
  const turn = session.sendMessage(route.message);
  turn.catch(() => undefined);
  await Promise.race([turn, Promise.resolve()]);
  return undefined;
}

function remoteSession(id: unknown): Session {
  const session = typeof id === 'string' ? sessions.get(id) : undefined;
  if (!session?.isRemote()) throw new Error('That session is not remote controlled.');
  return session;
}

function participantOf(session: Session, name: unknown): string {
  const participant = typeof name === 'string' ? session.getParticipants().find(agent => agent.name === name) : undefined;
  if (!participant) throw new Error(`${session.getName()} has no participant @${String(name)}.`);
  return participant.name;
}

function isAnswer(value: unknown): value is QuestionAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const answer = value as { action?: unknown; content?: unknown };
  return answer.action === 'decline'
    || (answer.action === 'accept' && typeof answer.content === 'object' && answer.content !== null && !Array.isArray(answer.content));
}

// Each request answered with a result; a failure's error is the sentence
// the phone shows. A type this build does not know is ignored.
async function handle(socket: Socket, frame: Frame): Promise<void> {
  const id = typeof frame.id === 'string' ? frame.id : '';
  let feedback: string | undefined;
  try {
    switch (frame.type) {
      case 'subscribe': {
        const session = remoteSession(frame.sessionId);
        subscribe(socket, session, participantOf(session, frame.participant));
        sendView(socket, true);
        break;
      }
      case 'send': {
        const session = remoteSession(frame.sessionId);
        if (typeof frame.text !== 'string' || !frame.text.trim()) throw new Error('There is nothing to send.');
        feedback = await sendText(socket, session, participantOf(session, frame.participant), frame.text);
        break;
      }
      case 'cancel': {
        const session = remoteSession(frame.sessionId);
        session.cancel();
        for (const { sessionId, controller } of socket.data.running) {
          if (sessionId === session.getId()) controller.abort();
        }
        break;
      }
      case 'approve': {
        const request = pendingApprovals().find(candidate => candidate.id === frame.requestId);
        if (!request || !sessions.get(request.sessionId)?.isRemote()
          || !request.options.some(option => option.optionId === frame.optionId)
          || !resolveApproval(request.id, { optionId: frame.optionId as string })) throw new Error('That approval is no longer waiting.');
        break;
      }
      case 'answer': {
        const request = pendingQuestions().find(candidate => candidate.id === frame.requestId);
        if (!request || !sessions.get(request.sessionId)?.isRemote()) throw new Error('That question is no longer waiting.');
        if (!isAnswer(frame.answer)) throw new Error('That answer is not one Sirus can read.');
        if (!resolveQuestion(request.id, frame.answer)) throw new Error('That question is no longer waiting.');
        break;
      }
      case 'device': {
        const { apnsToken, environment } = frame;
        if (typeof apnsToken !== 'string' || !/^[0-9a-f]+$/i.test(apnsToken)
          || !APNS_ENVIRONMENTS.includes(environment as typeof APNS_ENVIRONMENTS[number])) throw new Error('That device registration is not one Sirus can read.');
        const settings = openSettings();
        const remote = settings.get('remote');
        const others = (remote.devices ?? []).filter(device => device.token !== apnsToken);
        const known = remote.devices?.find(device => device.token === apnsToken);
        const device = { token: apnsToken, environment: environment as typeof APNS_ENVIRONMENTS[number], firstSeen: known?.firstSeen ?? Date.now() };
        // A phone registers on every connection, so the list's end is the
        // phones in use; the oldest registrations beyond it are dropped.
        const devices = [...others, device].slice(-MAX_DEVICES);
        if (!settings.set({ remote: { ...remote, devices } })) throw new Error('Sirus could not save this device to its settings.');
        break;
      }
      default:
        return;
    }
    socket.send(JSON.stringify({ type: 'result', id, ok: true, ...(feedback ? { feedback } : {}) }));
  } catch (error) {
    socket.send(JSON.stringify({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }));
  }
}

// ── The listener ─────────────────────────────────────────────────────────

// The phone's first connection ends the one-time setup: /rc stops showing
// the QR code.
function recordFirstConnection(): void {
  const settings = openSettings();
  const remote = settings.get('remote');
  if (remote.firstConnection === undefined) settings.set({ remote: { ...remote, firstConnection: Date.now() } });
}

function listen(self: { ip: string; host: string; user: string }): Listener {
  for (let port = PORTS.first; port <= PORTS.last; port++) {
    try {
      const server = Bun.serve<SocketData, never>({
        hostname: self.ip,
        port,
        async fetch(request, server) {
          const ip = server.requestIP(request)?.address ?? '';
          if (fromBrowser(request, self) || !await allowed(ip, self.user)) return new Response('Forbidden', { status: 403 });
          const { pathname } = new URL(request.url);
          if (request.method === 'GET' && pathname === '/v1/hello') return Response.json({ protocol: 1, sirus: SIRUS_VERSION, pid: process.pid });
          if (request.method === 'GET' && pathname === '/v1/socket') {
            if (server.upgrade(request, { data: { ip, subscription: null, running: new Set() } })) return undefined;
            return new Response('Expected a WebSocket', { status: 400 });
          }
          return new Response('Not found', { status: 404 });
        },
        websocket: {
          open(socket) {
            sockets.add(socket);
            recordFirstConnection();
            lastList = listFrame();
            socket.send(lastList);
          },
          message(socket, message) {
            let frame: unknown;
            try { frame = JSON.parse(String(message)); } catch { return; }
            if (typeof frame === 'object' && frame !== null && !Array.isArray(frame)) void handle(socket, frame as Frame);
          },
          close(socket) {
            unsubscribe(socket);
            for (const { controller } of socket.data.running) controller.abort();
            sockets.delete(socket);
          },
        },
      });
      return { server, host: self.host, port, user: self.user };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE') {
        throw new Error(`Remote control could not listen on ${self.ip}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(`No free port for remote control in ${PORTS.first}–${PORTS.last}: other Sirus windows hold them all. Close one and try /rc again.`);
}

function start(): Promise<Listener> {
  if (listener) return Promise.resolve(listener);
  starting ??= tailnetSelf().then(self => {
    listener = listen(self);
    return listener;
  }).finally(() => { starting = null; });
  return starting;
}

export function stopRemoteControl(): void {
  for (const socket of sockets) {
    unsubscribe(socket);
    socket.close();
  }
  sockets.clear();
  verdicts.clear();
  listener?.server.stop(true);
  listener = null;
  lastList = '';
}

// ── What the rest of Sirus calls ─────────────────────────────────────────

// Where the phone reaches this process, while it listens.
export function remoteAddress(): { host: string; port: number } | null {
  return listener ? { host: listener.host, port: listener.port } : null;
}

// Whether a phone has ever connected to this Mac.
export function phoneConnected(): boolean {
  return openSettings().get('remote').firstConnection !== undefined;
}

// /rc: turns remote control on for a session, starting the listener if it
// is the first, or off, stopping it after the last. Turning on fails, and
// the session stays off, when Tailscale cannot be used or no port is free.
export async function toggleRemote(session: Pick<Session, 'getId' | 'isRemote' | 'setRemote'>): Promise<string> {
  if (session.isRemote()) {
    session.setRemote(false);
    for (const socket of sockets) {
      if (socket.data.subscription?.session.getId() === session.getId()) unsubscribe(socket);
    }
    if (!remoteSessions().length) stopRemoteControl();
    listChanged();
    return 'Remote control off.';
  }
  const { host, port } = await start();
  session.setRemote(true);
  listChanged();
  const pushes = !toldAboutPushes && !openSettings().get('remote').apns;
  toldAboutPushes ||= pushes;
  return `Remote control on · ${host}:${port}${pushes ? '\nPush notifications are off: add remote.apns (keyPath, keyId, teamId, bundleId) to settings.json.' : ''}`;
}

// The app hands over every session it holds whenever the list changes. A
// session it replaced with a fresh copy keeps its phones subscribed; one it
// dropped loses them; the listener runs while any session has /rc on,
// including after a restart, when a failure is reported rather than thrown.
export function syncRemoteSessions(all: readonly Session[], report: (text: string) => void): () => void {
  sessions.clear();
  for (const session of all) sessions.set(session.getId(), session);
  for (const socket of sockets) {
    const subscription = socket.data.subscription;
    if (!subscription) continue;
    const current = sessions.get(subscription.session.getId());
    if (current === subscription.session) continue;
    if (current?.isRemote()) subscribe(socket, current, subscription.participant, subscription.rows);
    else unsubscribe(socket);
  }
  if (remoteSessions().length && !listener) {
    start().catch((error: unknown) => report(`Remote control is not listening. ${error instanceof Error ? error.message : String(error)}`));
  } else if (!remoteSessions().length && listener) {
    stopRemoteControl();
  }
  listChanged();
  const unsubscribes = all.map(session => session.subscribe(listChanged));
  return () => { for (const stop of unsubscribes) stop(); };
}

// The session and participant the terminal shows, which the app opens at.
export function setRemoteFocus(sessionId: string, participant: string): void {
  if (focus?.sessionId === sessionId && focus.participant === participant) return;
  focus = { sessionId, participant, at: Date.now() };
  listChanged();
}
