import { Text } from 'ink';
import type { Participant } from '../agent_runtime/session';
import { theme } from './styles/theme';
import { parseFileMentions } from '../fileMentions';

export interface MentionSegment {
  text: string;
  isMention: boolean;
}

const mentionPattern = /(?<![\w@])@[A-Za-z][A-Za-z0-9_-]*(?![A-Za-z0-9_\/-])/g;
const filenamePattern = /(?<![\w@])@(?:[A-Za-z0-9_.-]+\/)*(?=[A-Za-z0-9_.-]*\.[A-Za-z0-9_-])[A-Za-z0-9_.-]+(?![A-Za-z0-9_\/-])/g;

// Sirus keeps the original soft grey. Additional participants are ordered by
// creation and receive stable shades from the restrained blue-purple family.
export const participantPalette = [
  theme.accentSoft,
  theme.mention,
  '#A184D8',
  '#708FCB',
  '#9A82B8',
  '#6F9FB5',
  '#B07FA6',
  '#7E83C8',
  '#8CA7D6',
  '#9B8FC2',
  '#778DB8',
] as const;

export type ParticipantColors = ReadonlyMap<string, string>;

export function participantColorMap(participants: readonly Participant[]): Map<string, string> {
  let additionalIndex = 0;
  return new Map(participants.map(participant => {
    const name = participant.name.toLocaleLowerCase();
    if (name === 'sirus') return [name, theme.accentSoft];
    const color = participantPalette[1 + (additionalIndex % (participantPalette.length - 1))];
    additionalIndex++;
    return [name, color];
  }));
}

export function participantColor(name: string, colors?: ParticipantColors): string {
  const normalized = name.replace(/^@/, '').toLocaleLowerCase();
  if (normalized === 'sirus') return theme.accentSoft;
  const assigned = colors?.get(normalized);
  if (assigned) return assigned;

  // Unknown names are visible while the user is creating a participant. Give
  // those previews a deterministic palette color until the session assigns
  // their creation-order color.
  let hash = 0;
  for (const character of normalized) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return participantPalette[(hash >>> 0) % participantPalette.length];
}

export function mentionSegments(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const explicitFiles = parseFileMentions(text);
  // Relative file paths need no ./ prefix. Match the complete path and
  // extension so it never inherits the colour of a partial agent name.
  const files = [
    ...explicitFiles,
    ...Array.from(text.matchAll(filenamePattern), match => ({
      start: match.index!, end: match.index! + match[0].replace(/\.+$/, '').length,
    })).filter(mention => !explicitFiles.some(file => mention.start < file.end && mention.end > file.start)),
  ];
  const mentions = [
    ...files,
    ...Array.from(text.matchAll(mentionPattern), match => ({
      start: match.index!, end: match.index! + match[0].length,
    })).filter(mention => !files.some(file => mention.start < file.end && mention.end > file.start)),
  ].sort((left, right) => left.start - right.start);
  let offset = 0;
  for (const mention of mentions) {
    if (mention.start > offset) segments.push({ text: text.slice(offset, mention.start), isMention: false });
    segments.push({ text: text.slice(mention.start, mention.end), isMention: true });
    offset = mention.end;
  }
  if (offset < text.length) segments.push({ text: text.slice(offset), isMention: false });
  return segments;
}

export function MentionText({
  children,
  colors,
}: {
  children: string;
  colors?: ParticipantColors;
}) {
  return mentionSegments(children).map((segment, index) => segment.isMention
    ? <Text key={index} color={segment.text.includes('.') || /^@(?:\/|")/.test(segment.text)
      ? theme.textMuted : participantColor(segment.text, colors)}>{segment.text}</Text>
    : segment.text);
}
