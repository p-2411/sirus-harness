import { useEffect, useRef } from 'react';
import type { ImageBlock, MessageBlock } from '../../agent_runtime/types';
import { applyInputEdit, type InputState } from './editor';

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

// The images attached to the draft, and the placeholders holding their place
// in its text. New attachments are inserted at the cursor; placeholders whose
// image has gone are stripped. `getDraft`/`setDraft` reach the draft itself,
// which is not always what the input bar is showing — a queued message being
// edited sits in front of it.
export function useDraftImages({ attachments, text, getDraft, setDraft }: {
  attachments: readonly ImageBlock[];
  text: string;
  getDraft: () => InputState;
  setDraft: (state: InputState) => void;
}) {
  const placeholderPaths = useRef(new Map<string, string>());
  const allocated = useRef(0);
  const seenAttachments = useRef<readonly ImageBlock[] | null>(null);

  const imageFor = (placeholder: string): ImageBlock | undefined => {
    const path = placeholderPaths.current.get(placeholder);
    return path === undefined ? undefined : attachments.find(image => image.path === path);
  };
  const placedImages = imagePlaceholders(text).flatMap(placeholder => imageFor(placeholder) ?? []);
  const trailingImages = attachments.filter(image => !placedImages.includes(image));

  useEffect(() => {
    const previous = seenAttachments.current;
    seenAttachments.current = attachments;
    const draft = getDraft();
    let next = stripPlaceholders(draft, placeholder => !placeholderPaths.current.has(placeholder) || imageFor(placeholder) !== undefined);
    const added = previous === null ? [] : attachments.filter(image => !previous.some(item => item.path === image.path));
    if (added.length > 0) {
      const placeholders = added.map(image => {
        let placeholder = imagePlaceholder(allocated.current++);
        while (placeholderPaths.current.has(placeholder) || next.text.includes(placeholder)) {
          placeholder = imagePlaceholder(allocated.current++);
        }
        placeholderPaths.current.set(placeholder, image.path);
        return placeholder;
      });
      next = applyInputEdit(next, { type: 'insert', text: placeholders.join('') });
    }
    if (next.text !== draft.text || next.cursor !== draft.cursor) setDraft(next);
  }, [attachments]);

  return { imageFor, placedImages, trailingImages };
}
