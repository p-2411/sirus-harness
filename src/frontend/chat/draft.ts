import { useEffect, useRef } from 'react';
import type { ImageBlock, MessageBlock } from '../../agent_runtime/types';
import { applyInputEdit, type InputState } from './editor';

// An attached image sits in the draft as one private-use character, so the
// text can refer to it where the user put it and editing moves or removes it
// like any other character. The character means something only to the input
// bar that allocated it; unknown private-use characters remain ordinary text.
const FIRST_PLACEHOLDER = 0xE000;
const LAST_PLACEHOLDER = 0xF8FF;

function imagePlaceholder(index: number): string {
  return String.fromCharCode(FIRST_PLACEHOLDER + (index % (LAST_PLACEHOLDER - FIRST_PLACEHOLDER + 1)));
}

export function isImagePlaceholder(character: string): boolean {
  const code = character.charCodeAt(0);
  return character.length === 1 && code >= FIRST_PLACEHOLDER && code <= LAST_PLACEHOLDER;
}

function imagePlaceholders(text: string): string[] {
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
export interface DraftImageState {
  paths: Map<string, string>;
  allocated: number;
  seen: readonly ImageBlock[] | null;
}

export function createDraftImageState(): DraftImageState {
  return { paths: new Map(), allocated: 0, seen: null };
}

// Reserve a draft position before a queued image is reattached. Its later
// attachment update can then reuse this position instead of appending it.
export function reserveImagePlaceholder(state: DraftImageState, image: ImageBlock, text: string): string {
  let placeholder = imagePlaceholder(state.allocated++);
  while (state.paths.has(placeholder) || text.includes(placeholder)) {
    placeholder = imagePlaceholder(state.allocated++);
  }
  state.paths.set(placeholder, image.path);
  return placeholder;
}

export function useDraftImages({ attachments, text, getDraft, setDraft, state }: {
  attachments: readonly ImageBlock[];
  text: string;
  getDraft: () => InputState;
  setDraft: (state: InputState) => void;
  state?: DraftImageState;
}) {
  const memory = useRef(state ?? createDraftImageState()).current;
  const placeholderPaths = { current: memory.paths };

  const imageFor = (placeholder: string): ImageBlock | undefined => {
    const path = placeholderPaths.current.get(placeholder);
    return path === undefined ? undefined : attachments.find(image => image.path === path);
  };
  const placedImages = imagePlaceholders(text).flatMap(placeholder => imageFor(placeholder) ?? []);
  const trailingImages = attachments.filter(image => !placedImages.includes(image));

  useEffect(() => {
    const previous = memory.seen;
    memory.seen = attachments;
    const draft = getDraft();
    let next = stripPlaceholders(draft, placeholder => !placeholderPaths.current.has(placeholder) || imageFor(placeholder) !== undefined);
    const added = previous === null ? [] : attachments.filter(image =>
      !previous.some(item => item.path === image.path)
      && ![...placeholderPaths.current].some(([placeholder, path]) => path === image.path && next.text.includes(placeholder)));
    if (added.length > 0) {
      const placeholders = added.map(image => reserveImagePlaceholder(memory, image, next.text));
      next = applyInputEdit(next, { type: 'insert', text: placeholders.join('') });
    }
    if (next.text !== draft.text || next.cursor !== draft.cursor) setDraft(next);
  }, [attachments]);

  return {
    imageFor,
    isKnownPlaceholder: (placeholder: string) => placeholderPaths.current.has(placeholder),
    placedImages,
    trailingImages,
  };
}
