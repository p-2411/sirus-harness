// Draft text as the user sees it: their own words, with each attached image
// drawn as a chip where its placeholder sits.
import type { ReactNode } from 'react';
import { Text } from 'ink';
import { theme } from '../styles/theme';
import { MentionText, type ParticipantColors } from '../MentionText';
import type { ImageBlock } from '../../agent_runtime/types';
import { describeImage } from '../../images';
import { isImagePlaceholder } from './draft';
import type { DraftCell } from './editor';

function imageChip(image: ImageBlock): string {
  return `[${describeImage(image)}]`;
}

export function DraftText({ text, imageFor, participantColors }: {
  text: string;
  imageFor: (placeholder: string) => ImageBlock | undefined;
  participantColors?: ParticipantColors;
}) {
  const parts: ReactNode[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) parts.push(<MentionText key={parts.length} colors={participantColors}>{buffer}</MentionText>);
    buffer = '';
  };
  for (const character of text) {
    if (!isImagePlaceholder(character)) {
      buffer += character;
      continue;
    }
    const image = imageFor(character);
    if (!image) {
      buffer += character;
      continue;
    }
    flush();
    parts.push(<Text key={parts.length} color={theme.textMuted}>{imageChip(image)}</Text>);
  }
  flush();
  return <>{parts}</>;
}

// Images the draft no longer places (its text was replaced by a recall, or
// the message was refused): they go at the end.
export function TrailingImages({ images, after }: { images: readonly ImageBlock[]; after: boolean }) {
  if (images.length === 0) return null;
  const chips = images.map(imageChip).join(' ');
  return <Text color={theme.textMuted}>{after ? ` ${chips}` : `${chips} `}</Text>;
}

export function DraftRow({ cells, cursor, participantColors }: {
  cells: DraftCell[];
  cursor: number;
  participantColors?: ParticipantColors;
}) {
  const parts: ReactNode[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) parts.push(<MentionText key={parts.length} colors={participantColors}>{buffer}</MentionText>);
    buffer = '';
  };
  for (const cell of cells) {
    if ((cell.start <= cursor && cursor < Math.max(cell.end, cell.start + 1)) || cell.chip) {
      flush();
      parts.push(<Text key={parts.length} inverse={cell.start <= cursor && cursor < Math.max(cell.end, cell.start + 1)} color={cell.chip ? theme.textMuted : theme.text}>{cell.text}</Text>);
    } else buffer += cell.text;
  }
  flush();
  return <Text wrap="truncate-end">{parts}</Text>;
}
