import type { Message } from '../data/data';
import {
  loadSubscriptionPreferences,
  saveSubscriptionPreferences,
  type SubscriptionPreferences,
} from '../data/persistence';

// Which provider login drives a model when the user has enabled subscription
// mode. Anything else keeps using the API-key providers.
export type Vendor = 'claude' | 'gpt';

export const VENDORS: readonly Vendor[] = ['claude', 'gpt'];

const enabled: Record<Vendor, boolean> = { claude: false, gpt: false };
let preferencesLoaded = false;

function ensurePreferencesLoaded(): void {
  if (preferencesLoaded) return;
  Object.assign(enabled, loadSubscriptionPreferences());
  preferencesLoaded = true;
}

export function vendorOf(model: string): Vendor | null {
  if (model.startsWith('claude')) return 'claude';
  if (model.startsWith('gpt')) return 'gpt';
  return null;
}

export function parseVendor(name: string | undefined): Vendor {
  if (name === 'claude' || name === 'gpt') return name;
  throw new Error(`Unknown provider "${name ?? ''}". Try: ${VENDORS.join(', ')}`);
}

export function isSubscriptionEnabled(vendor: Vendor): boolean {
  ensurePreferencesLoaded();
  return enabled[vendor];
}

export function setSubscriptionEnabled(vendor: Vendor, on: boolean): void {
  ensurePreferencesLoaded();
  enabled[vendor] = on;
  saveSubscriptionPreferences(enabled as SubscriptionPreferences);
}

export function latestUserText(messages: readonly Message[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    throw new Error('Subscription providers expect the latest message to come from the user');
  }
  return last.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

// The provider runtime keeps its own history, so a session that already has
// turns when it first reaches that runtime hands them over as plain text.
export function transcript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const speaker = message.role === 'user'
      ? 'User'
      : `@${message.participant ?? 'sirus'}`;
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text) lines.push(`${speaker}: ${block.text}`);
      } else if (block.type === 'tool_call') {
        lines.push(`${speaker} called tool ${block.name} with ${JSON.stringify(block.arguments)}`);
      } else {
        lines.push(`Tool result${block.isError ? ' (error)' : ''}: ${block.result}`);
      }
    }
  }
  return lines.join('\n');
}

// Long-lived subscription runtimes already remember their own turns. Replay
// only shared messages added since this participant's previous turn, omitting
// its own response (which the provider thread already contains).
export function promptWithSharedHistory(
  messages: readonly Message[],
  isFirstTurn: boolean,
  seenMessageCount: number,
  participantName: string,
  turnPrompt?: string,
): string {
  const text = turnPrompt ?? latestUserText(messages);
  const historyEnd = turnPrompt ? messages.length : -1;
  const earlier = (isFirstTurn
    ? messages.slice(0, historyEnd)
    : messages.slice(seenMessageCount, historyEnd))
    .filter(message => !(
      !isFirstTurn
      && message.role === 'assistant'
      && (message.participant ?? 'sirus').toLocaleLowerCase() === participantName.toLocaleLowerCase()
    ));
  if (earlier.length === 0) return text;
  return [
    isFirstTurn ? 'Earlier conversation, for context:' : 'New shared session messages, for context:',
    transcript(earlier),
    '',
    text,
  ].join('\n');
}
