import type { Requester } from './approvals';

// Sirus's three modes are the vendor's. Setting one switches each participant's
// session with `session/set_mode` to the vendor mode of the matching kind:
//   ask    — standard: the vendor asks about every action that is not a read
//   auto   — auto_review: the vendor's own reviewer decides and escalates only
//            what it judges unsafe
//   bypass — full_access: nothing is asked
// The kind each mode maps onto is `MODE_KINDS` in `runtime/runtime.ts`, which
// also picks the vendor mode. Whatever the vendor escalates arrives as
// `session/request_permission` and is answered by `./approvals`.

export type PermissionMode = 'ask' | 'auto' | 'bypass';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'bypass'];

export const PERMISSION_MODE_NAMES: Record<PermissionMode, string> = {
  ask: 'ask for approval',
  auto: 'auto approve',
  bypass: 'bypass permissions',
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

export function parsePermissionMode(value: unknown): PermissionMode | null {
  return value === 'ask' || value === 'auto' || value === 'bypass' ? value : null;
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
}

// Who is asking, for which Sirus session: stamped on every escalation a
// participant's runtime raises, so the prompt can name the asker and the
// decision can be filed under the session. A subagent carries its own.
export interface PermissionContext {
  sessionId: string;
  requester: Requester;
}
