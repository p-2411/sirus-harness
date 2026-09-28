import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import { homedir } from 'node:os';
import type { Session } from '../agent_runtime/session';
import { DEFAULT_PARTICIPANT } from '../agent_runtime/types';
import type { ApprovalRequest } from '../agent_runtime/permissions/approvals';
import type { QuestionRequest } from '../agent_runtime/permissions/questions';
import { openSettings, type RemoteSettings } from '../persistence/settings';
import { remoteAddress } from './index';
import { requestOwner } from './view';

// Push notifications for sessions with /rc on, sent by Sirus itself through
// APNs with the owner's .p8 key (`remote.apns` in settings.json). The desktop
// notifications in `frontend/useNotifications.ts` call this beside their own,
// with the same words. Best effort: a push that fails is not retried.

type ApnsKey = NonNullable<RemoteSettings['apns']>;
type Device = NonNullable<RemoteSettings['devices']>[number];

export type RemoteEvent =
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'finished' };

// APNs takes a token for up to an hour and refuses one refreshed more often
// than every twenty minutes.
const TOKEN_LIFETIME_MS = 50 * 60_000;
const PUSH_TIMEOUT_MS = 10_000;
let token: { key: string; value: string; at: number } | null = null;

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

// The provider token: an ES256 JWT naming the key and the team, signed with
// the key itself.
export function apnsToken(key: ApnsKey, now = Date.now()): string {
  const cacheKey = `${key.keyPath}\n${key.keyId}\n${key.teamId}`;
  if (token?.key === cacheKey && now - token.at < TOKEN_LIFETIME_MS) return token.value;
  const input = `${base64url(JSON.stringify({ alg: 'ES256', kid: key.keyId }))}.${base64url(JSON.stringify({ iss: key.teamId, iat: Math.floor(now / 1000) }))}`;
  const pem = readFileSync(key.keyPath.replace(/^~(?=\/)/, homedir()));
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
  token = { key: cacheKey, value: `${input}.${base64url(signature)}`, at: now };
  return token.value;
}

function post(device: Device, key: ApnsKey, payload: object): Promise<{ status: number; reason?: string }> {
  const origin = device.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  return new Promise((resolve, reject) => {
    const authorization = `bearer ${apnsToken(key)}`;
    const client = connect(origin);
    const fail = (error: Error) => { client.destroy(); reject(error); };
    // An unanswered connection error would take the whole process down.
    client.on('error', fail);
    client.setTimeout(PUSH_TIMEOUT_MS, () => fail(new Error('APNs timed out.')));
    const stream = client.request({
      ':method': 'POST', ':path': `/3/device/${device.token}`,
      authorization, 'apns-topic': key.bundleId, 'apns-push-type': 'alert',
    });
    let status = 0;
    let body = '';
    stream.on('response', headers => { status = Number(headers[':status']); });
    stream.on('data', chunk => { body += String(chunk); });
    stream.on('error', fail);
    stream.on('end', () => {
      client.close();
      let reason: string | undefined;
      try { reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined; } catch { /* no reason given */ }
      resolve({ status, ...(reason ? { reason } : {}) });
    });
    stream.end(JSON.stringify(payload));
  });
}

// A token APNs no longer knows belongs to an app that was deleted, or a
// phone that was reset: nothing will ever arrive there again.
function forget(device: Device): void {
  const settings = openSettings();
  const remote = settings.get('remote');
  settings.set({ remote: { ...remote, devices: (remote.devices ?? []).filter(item => item.token !== device.token) } });
}

// Which participant's conversation the push opens: the one a request waits
// on, or the one whose reply ended the turn.
function participantOf(session: Session, event: RemoteEvent): string {
  if (event.kind !== 'finished') return requestOwner(session, event.request.requester) ?? session.getSelectedParticipant();
  const last = [...session.getMessages()].reverse().find(message => message.role === 'assistant' && !message.hidden);
  return last?.participant ?? DEFAULT_PARTICIPANT;
}

// An approval's category picks the lock-screen buttons, by the kinds of
// option it offers; `sirus.options` maps each kind to the option to answer
// with, so the app answers by kind. That is the first option of the kind,
// as `chosenOption` picks it in the terminal: a vendor can list a broader
// grant under the same kind later, and a fixed button must not reach it.
export function approvalFields(request: Pick<ApprovalRequest, 'options'>) {
  const options: Record<string, string> = {};
  for (const option of request.options) {
    if (option.kind !== 'allow_once' && option.kind !== 'allow_always' && option.kind !== 'reject_once') continue;
    options[option.kind] ??= option.optionId;
  }
  return { category: 'allow_always' in options ? 'APPROVAL_ALWAYS' : 'APPROVAL', options };
}

export function pushRemote(session: Session, title: string, body: string, event: RemoteEvent): void {
  if (!session.isRemote()) return;
  const address = remoteAddress();
  const { apns, devices } = openSettings().get('remote');
  if (!address || !apns || !devices?.length) return;
  const approval = event.kind === 'approval' ? approvalFields(event.request) : null;
  const payload = {
    aps: { alert: { title, body }, 'thread-id': session.getId(), sound: 'default', ...(approval ? { category: approval.category } : {}) },
    sirus: {
      sessionId: session.getId(), participant: participantOf(session, event),
      ...(event.kind !== 'finished' ? { requestId: event.request.id } : {}),
      host: address.host, port: address.port,
      ...(approval ? { options: approval.options } : {}),
    },
  };
  for (const device of devices) {
    void post(device, apns, payload)
      .then(response => { if (response.status === 410 || response.reason === 'Unregistered') forget(device); })
      .catch(() => { /* Pushes are best effort; the phone still sees the session when it opens. */ });
  }
}
