import { VENDOR_INFO, type Vendor } from '../providers/catalog';

// Transport failures can be retried once. Vendor refusals must keep their
// meaning even when the adapter wraps them in JSON-RPC's Internal error.
export class AdapterLostError extends Error {}

export interface TurnFailure {
  kind: 'limit' | 'login' | 'crash' | 'refused';
  message: string;
}

function resetDescription(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 5) return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:resets?At|reset_at|reset_time)$/i.test(key)) {
      const number = typeof nested === 'number' ? nested : Number(nested);
      const time = Number.isFinite(number) && number > 0
        ? number * (number < 1e12 ? 1000 : 1) : typeof nested === 'string' ? Date.parse(nested) : NaN;
      if (Number.isFinite(time) && time > Date.now() && time < 8.64e15) return `Resets at ${new Date(time).toLocaleString()}`;
    }
    if (/^retry_?after$/i.test(key) && Number(nested) > 0) return `Try again in ${Number(nested)} seconds`;
    const found = resetDescription(nested, depth + 1);
    if (found) return found;
  }
}

export function turnFailure(error: unknown, vendor: Vendor, participant: string, resetsAt?: number): TurnFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause ?? error : error;
  const metadata = cause && typeof cause === 'object' ? (cause as { data?: unknown }).data : undefined;
  const data = JSON.stringify(metadata ?? '');
  const evidence = `${detail} ${data}`;
  const name = VENDOR_INFO[vendor].displayName;
  if (error instanceof AdapterLostError) return { kind: 'crash', message: `${name} adapter stopped unexpectedly. Please try again.` };
  if (/rate.?limit|usage.?limit|quota|allowance|insufficient_quota|credit balance|limit reached|limit exceeded|too many requests|\b429\b/i.test(evidence)) {
    const spent = /quota|allowance|credit balance|usage.?limit/i.test(evidence);
    const reset = resetDescription(metadata)
      ?? /\b(?:resets?\b(?: at| on| in)?|try again (?:at|in|after)|retry[- ]after[: ]+)\s*[^\n|"}.]+/i.exec(detail)?.[0]
        .split(/\b(?:request|authorization|bearer|token|api.?key)\b/i)[0].trim().slice(0, 160)
      ?? resetDescription({ resetsAt });
    const command = participant === 'sirus' ? '/model' : `/model @${participant}`;
    const model = vendor === 'gpt' ? 'claude-sonnet-5' : 'gpt-5.6-luna';
    return { kind: 'limit', message: `${name} ${spent ? 'allowance is exhausted' : 'is rate limiting this request'}.${reset ? ` ${reset.replace(/[.\s]+$/, '')}.` : ''} To use the other vendor, type ${command} ${model}.` };
  }
  if (/unauthori[sz]ed|authentication|auth_required|invalid.?api.?key|invalid.?token|expired|\b401\b|not logged in|sign in|log in/i.test(evidence)) {
    return { kind: 'login', message: `${name} login expired or was rejected. Run /login to sign in again.` };
  }
  if (/adapter (?:exited|closed|failed to start)|connection (?:closed|lost)|transport_lost|runtime did not answer a cancel|\bEPIPE\b/i.test(evidence)) {
    return { kind: 'crash', message: `${name} adapter stopped unexpectedly. Please try again.` };
  }
  return { kind: 'refused', message: `${name} refused or could not complete this request. Try again or revise the prompt.` };
}
