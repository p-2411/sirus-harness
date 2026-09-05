import type { ImageBlock, MessageBlock } from '../../agent_runtime/types';
import type { InputState } from './InputBar';

// An attached image sits in the draft as one private-use character, so the
// text can refer to it where the user put it and editing moves or removes it
// like any other character. The character means something only to the input
// bar that allocated it; unknown private-use characters remain ordinary text.
const FIRST_PLACEHOLDER = 0xE000;
const LAST_PLACEHOLDER = 0xF8FF;

export function imagePlaceholder(index: number): string {
  return String.fromCharCode(FIRST_PLACEHOLDER + (index % (LAST_PLACEHOLDER - FIRST_PLACEHOLDER + 1)));
}

export function isImagePlaceholder(character: string): boolean {
  const code = character.charCodeAt(0);
  return character.length === 1 && code >= FIRST_PLACEHOLDER && code <= LAST_PLACEHOLDER;
}

export function imagePlaceholders(text: string): string[] {
  return [...text].filter(isImagePlaceholder);
}

// The placeholders an edit deleted; each is unique within a draft.
export function removedPlaceholders(before: string, after: string): string[] {
  const remaining = new Set(imagePlaceholders(after));
  return imagePlaceholders(before).filter(placeholder => !remaining.has(placeholder));
}

// Drops the placeholders `keep` rejects, moving the cursor with the text.
export function stripPlaceholders(state: InputState, keep: (placeholder: string) => boolean): InputState {
  let text = '';
  let cursor = state.cursor;
  for (let index = 0; index < state.text.length; index++) {
    const character = state.text[index];
    if (isImagePlaceholder(character) && !keep(character)) {
      if (index < state.cursor) cursor--;
      continue;
    }
    text += character;
  }
  return { text, cursor };
}

// Message content in draft order: text around each marked image, then any
// images the draft no longer mentions so none are lost.
export function composeContent(
  text: string,
  imageFor: (placeholder: string) => ImageBlock | undefined,
  trailing: readonly ImageBlock[] = [],
): MessageBlock[] {
  const content: MessageBlock[] = [];
  let pending = '';
  const flush = () => {
    if (pending) content.push({ type: 'text', text: pending });
    pending = '';
  };
  for (const character of text) {
    const image = imageFor(character);
    if (image) {
      flush();
      content.push(image);
    } else {
      pending += character;
    }
  }
  flush();
  content.push(...trailing);
  return content;
}
