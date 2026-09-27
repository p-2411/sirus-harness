// An agent's question to the user as a framed card, one field at a time:
// a choice among options (several for a multiple choice), with "Other…" for
// an answer of the user's own where the agent takes one, or a typed value.
// ← steps back to the field before; the answers go back when the last field
// is answered.
import { useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { FramedCard } from './FramedCard';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';
import { terminalText } from '../terminal/text';
import { backspaceAtEnd } from './editor';
import { describeRequester } from '../../agent_runtime/permissions/approvals';
import type { QuestionAnswer, QuestionField, QuestionOption, QuestionRequest } from '../../agent_runtime/permissions/questions';

type Answers = Record<string, string | number | boolean | string[]>;

// The rows a field offers: its options, Yes and No for a yes-or-no, and
// "Other…" last when the agent takes an answer of the user's own. An
// option's words are the agent's, so they are made safe to print here.
interface Row {
  label: string;
  description?: string;
  value?: string | boolean;
  other?: true;
}

function rowsOf(field: QuestionField): Row[] {
  if (field.kind === 'boolean') return [{ label: 'Yes', value: true }, { label: 'No', value: false }];
  if (field.kind !== 'choice') return [];
  const rows: Row[] = field.options.map((option: QuestionOption) => ({
    label: terminalText(option.label),
    value: option.value,
    ...(option.description ? { description: terminalText(option.description) } : {}),
  }));
  if (field.other) rows.push({ label: 'Other…', description: 'type your own answer', other: true });
  return rows;
}

// What the card asks for a field. Claude puts a lone question in the form's
// message and a short header in the field's title; Codex puts the question
// in the title and the header in the description. The question is the line
// that reads as one, and a short other line becomes its label.
export function questionText(request: QuestionRequest, field: QuestionField): { question: string; label?: string } {
  const single = request.fields.length === 1;
  const candidates = [single ? request.message : undefined, field.description, field.title]
    .filter((line): line is string => Boolean(line));
  const question = candidates.find(line => line.trim().endsWith('?')) ?? (single ? request.message : field.title);
  const label = [field.title, field.description].find(line => line && line !== question && line.length <= 30);
  return { question, ...(label ? { label } : {}) };
}

function progress(count: number, index: number): string {
  if (count <= 1) return '';
  return `${index + 1} of ${count} ${Array.from({ length: count }, (_, dot) => (dot <= index ? '●' : '○')).join(' ')}`;
}

export function QuestionCard({ request, waiting, onAnswer }: {
  request: QuestionRequest;
  waiting: number;
  onAnswer: (answer: QuestionAnswer) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [selected, setSelected] = useState(0);
  const [picked, setPicked] = useState<readonly string[]>([]);
  // Typing a value: the field's own, or the answer behind "Other…".
  const [typingOther, setTypingOther] = useState(false);
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);

  const field = request.fields[index];
  const rows = rowsOf(field);
  const typing = typingOther || field.kind === 'text' || field.kind === 'number';

  // Moves to a field with what was answered so far, showing what it had.
  const goTo = (next: number, nextAnswers: Answers) => {
    if (next >= request.fields.length) {
      onAnswer({ action: 'accept', content: nextAnswers });
      return;
    }
    const target = request.fields[next];
    const had = nextAnswers[target.key];
    setAnswers(nextAnswers);
    setIndex(next);
    setPicked(Array.isArray(had) ? had : []);
    setSelected(Math.max(0, rowsOf(target).findIndex(row => row.value !== undefined && row.value === had)));
    setTypingOther(false);
    setEntry(target.kind === 'text' || target.kind === 'number' ? String(had ?? '') : '');
    setError(null);
  };

  const without = (keys: readonly (string | undefined)[]): Answers => {
    const next = { ...answers };
    for (const key of keys) if (key) delete next[key];
    return next;
  };

  const submitEntry = () => {
    const value = entry.trim();
    if (typingOther && field.kind === 'choice' && field.other) {
      if (!value) return;
      const next = { ...without([field.key]), [field.other.key]: value };
      if (field.multiple) next[field.key] = [...picked];
      else if (field.other.value) next[field.key] = field.other.value;
      goTo(index + 1, next);
      return;
    }
    if (field.kind === 'text') {
      if (!value && field.required) return;
      goTo(index + 1, value ? { ...answers, [field.key]: value } : without([field.key]));
      return;
    }
    if (field.kind === 'number') {
      if (!value) {
        if (!field.required) goTo(index + 1, without([field.key]));
        return;
      }
      const number = Number(value);
      if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number))) {
        setError(field.integer ? 'Enter a whole number.' : 'Enter a number.');
        return;
      }
      if (field.minimum !== undefined && number < field.minimum) return setError(`At least ${field.minimum}.`);
      if (field.maximum !== undefined && number > field.maximum) return setError(`At most ${field.maximum}.`);
      goTo(index + 1, { ...answers, [field.key]: number });
    }
  };

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.other) {
      setTypingOther(true);
      setEntry(field.kind === 'choice' && field.other ? String(answers[field.other.key] ?? '') : '');
      return;
    }
    if (field.kind === 'choice' && field.multiple) {
      goTo(index + 1, { ...without([field.other?.key]), [field.key]: [...picked] });
      return;
    }
    goTo(index + 1, { ...without([field.kind === 'choice' ? field.other?.key : undefined]), [field.key]: row.value! });
  };

  const toggle = (row: Row | undefined) => {
    if (!row || typeof row.value !== 'string') return;
    const value = row.value;
    setPicked(current => (current.includes(value) ? current.filter(item => item !== value) : [...current, value]));
  };

  usePaste(text => {
    if (typing) setEntry(current => current + text.replace(/\r?\n/g, ' '));
  });

  useInput((input, key) => {
    if (isMouseInput(input) || isFocusInput(input)) return;
    // Escape is the turn's cancel and session switching the sidebar's.
    if (key.escape || (key.meta && (key.upArrow || key.downArrow))) return;
    const isBackspace = key.backspace || key.delete;
    if (typing) {
      if (key.return) submitEntry();
      else if ((key.leftArrow || isBackspace) && entry === '') {
        if (typingOther) setTypingOther(false);
        else if (key.leftArrow && index > 0) goTo(index - 1, answers);
      } else if (isBackspace) setEntry(backspaceAtEnd);
      else if (key.ctrl && input === 'u') setEntry('');
      else if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow
        && !key.leftArrow && !key.rightArrow && !key.pageUp && !key.pageDown && !key.home && !key.end) {
        setEntry(current => current + input);
        setError(null);
      }
      return;
    }
    const multiple = field.kind === 'choice' && field.multiple;
    if (key.upArrow) setSelected(current => (current - 1 + rows.length) % rows.length);
    else if (key.downArrow) setSelected(current => (current + 1) % rows.length);
    else if (key.leftArrow && index > 0) goTo(index - 1, answers);
    else if (multiple && input === ' ') {
      if (rows[selected]?.other) choose(rows[selected]);
      else toggle(rows[selected]);
    } else if (key.return) choose(rows[selected]);
    else if (/^[1-9]$/.test(input) && Number(input) <= rows.length) {
      const row = rows[Number(input) - 1];
      setSelected(Number(input) - 1);
      if (multiple && !row.other) toggle(row);
      else choose(row);
    }
  });

  const { question, label } = questionText(request, field);
  const count = progress(request.fields.length, index);
  const right = [count, waiting > 0 ? `${waiting} more` : ''].filter(Boolean).join(' · ');
  const multiple = field.kind === 'choice' && field.multiple;
  const back = index > 0 ? ' · ← back' : '';
  const footer = typing
    ? `enter ${typingOther || entry.trim() || (field.kind !== 'choice' && field.required) ? 'submit' : 'skip'}${typingOther ? ' · ← options' : back} · esc cancels`
    : multiple
      ? `↑↓ move · space toggle · enter confirm${back} · esc cancels`
      : `↑↓ move · enter select${back} · esc cancels`;
  const column = Math.max(0, ...rows.map(row => row.label.length)) + (multiple ? 6 : 2);
  const secret = field.kind === 'text' && field.secret && !typingOther;

  return (
    <FramedCard
      tone={theme.accent}
      title={[
        { text: '? ', color: theme.accent },
        { text: describeRequester(request.requester), color: theme.accent, bold: true },
        { text: ' asks' },
        ...(label ? [{ text: ` · ${terminalText(label)}`, color: theme.textMuted }] : []),
      ]}
      {...(right ? { right } : {})}
      footer={footer}
    >
      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        {/* A form of several fields says what it is for once, above each. */}
        {request.fields.length > 1 && request.message !== question && (
          <Text color={theme.textMuted} wrap="wrap">{terminalText(request.message)}</Text>
        )}
        <Text color={theme.text} bold wrap="wrap">{terminalText(question)}</Text>
      </Box>
      {!typing && rows.map((row, rowIndex) => {
        const active = rowIndex === selected;
        const mark = multiple && !row.other
          ? (typeof row.value === 'string' && picked.includes(row.value) ? '[x] ' : '[ ] ')
          : multiple ? '    ' : '';
        return (
          <Box key={`${row.label}-${rowIndex}`}>
            <Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text>
            <Text color={active ? theme.accent : theme.text} wrap="truncate-end">
              {`${mark}${row.label}`.padEnd(column)}
            </Text>
            {row.description && <Text color={theme.textMuted} wrap="truncate-end">{row.description}</Text>}
          </Box>
        );
      })}
      {typing && (
        <Box flexDirection="column">
          {typingOther && <Text color={theme.textMuted}>  Your answer</Text>}
          <Text>
            <Text color={theme.accent}>› </Text>
            <Text color={theme.text}>{secret ? '•'.repeat(entry.length) : entry}</Text>
            <Text color={theme.accent}>▌</Text>
          </Text>
          {error && <Text color={theme.danger}>  {error}</Text>}
        </Box>
      )}
    </FramedCard>
  );
}
