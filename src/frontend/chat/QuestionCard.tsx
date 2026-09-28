// One question at a time, with drafts kept while the user moves back and
// forth. A form with several questions is reviewed before its answers go out.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Box, Text, useBoxMetrics, useInput, usePaste, useStdout, type DOMElement } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../styles/theme';
import { FramedCard, type TitlePart } from './FramedCard';
import {
  applyInputEdit,
  characterCount,
  inputEditForKey,
  isForeignInput,
  isKeyboardProtocolReport,
  isTypedText,
  type InputEdit,
  type InputState,
} from './editor';
import { useClickable } from '../interaction/clickable';
import { terminalText } from '../terminal/text';
import { describeRequester } from '../../agent_runtime/permissions/approvals';
import type { QuestionAnswer, QuestionField, QuestionRequest } from '../../agent_runtime/permissions/questions';

type Answers = Record<string, string | number | boolean | string[]>;
// Typing an answer of the user's own is having "Other…" highlighted, so the
// typed text stays with the field while the highlight moves elsewhere.
interface Draft {
  selected: number;
  picked: readonly string[];
  editor: InputState;
}
const EMPTY_DRAFT: Draft = { selected: 0, picked: [], editor: { text: '', cursor: 0 } };

// Narrower than this inside the card, the highlighted option's details go
// under it instead of beside the list.
const SIDE_BY_SIDE_WIDTH = 70;

interface Row {
  label: string;
  description?: string;
  value?: string | boolean;
  action?: 'other' | 'continue' | 'skip';
}

// The rows a field offers. An option's words are the agent's, so they are
// made safe to print here.
function rowsOf(field: QuestionField): Row[] {
  const rows: Row[] = field.kind === 'boolean'
    ? [{ label: 'Yes', value: true }, { label: 'No', value: false }]
    : field.kind === 'choice' ? field.options.map(option => ({
      label: terminalText(option.label),
      value: option.value,
      ...(option.description ? { description: terminalText(option.description) } : {}),
    })) : [];
  if (field.kind === 'choice' && field.other) rows.push({ label: 'Other…', description: 'Type your own answer', action: 'other' });
  if (field.kind === 'choice' && field.multiple) rows.push({ label: 'Continue', action: 'continue' });
  else if (!field.required) rows.push({ label: 'Skip question', action: 'skip' });
  return rows;
}

// Claude puts a lone question in the message and a short header in the
// field's title; Codex puts the question in the title and header in description.
export function questionText(request: QuestionRequest, field: QuestionField): { question: string; label?: string } {
  const single = request.fields.length === 1;
  const candidates = [single ? request.message : undefined, field.description, field.title]
    .filter((line): line is string => Boolean(line));
  const question = candidates.find(line => line.trim().endsWith('?')) ?? (single ? request.message : field.title);
  const label = [field.title, field.description].find(line => line && line !== question && line.length <= 30);
  return { question, ...(label ? { label } : {}) };
}

// Who is asking, as the card's top edge sets it after its mark and the
// desktop notification says it ahead of the question: "@sirus asks".
export function questionTitle(request: QuestionRequest): TitlePart[] {
  return [
    { text: describeRequester(request.requester), color: theme.accent, bold: true },
    { text: ' asks' },
  ];
}

function QuestionRow({ label, active, prefix, onChoose, focusRef, children }: {
  label: string;
  active: boolean;
  prefix?: string;
  onChoose: () => void;
  focusRef?: RefObject<DOMElement | null>;
  children?: ReactNode;
}) {
  const ref = useRef<DOMElement>(null);
  const hovered = useClickable(ref, onChoose);
  return (
    <Box ref={focusRef} flexShrink={0} width="100%">
      <Box ref={ref} width="100%">
        <Box width={2} flexShrink={0}><Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text></Box>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
          <Text color={active || hovered ? theme.highlight : theme.text} bold={active} wrap="wrap">{prefix}{label}</Text>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

function Entry({ editor, secret }: { editor: InputState; secret?: boolean }) {
  const shown = (text: string) => secret ? '•'.repeat(characterCount(text)) : text;
  return (
    <Text wrap="wrap">
      <Text color={theme.text}>{shown(editor.text.slice(0, editor.cursor))}</Text>
      <Text color={theme.accent}>▌</Text>
      <Text color={theme.text}>{shown(editor.text.slice(editor.cursor))}</Text>
    </Text>
  );
}

// Long option lists keep the current choice in view without displacing the
// question or its keys. Descriptions wrap at the width the card actually has.
function Choices({ selected, children, focusRef }: {
  selected: number;
  children: ReactNode;
  focusRef: RefObject<DOMElement | null>;
}) {
  const { stdout } = useStdout();
  const contentRef = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(contentRef);
  const focused = useBoxMetrics(focusRef);
  const limit = Math.max(3, Math.floor((stdout.rows ?? 24) * 0.4));
  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, height - limit);
  useEffect(() => {
    setOffset(current => Math.max(0, Math.min(maxOffset,
      focused.top < current ? focused.top
        : focused.top + Math.min(focused.height, limit) > current + limit
          ? focused.top + Math.min(focused.height, limit) - limit : current)));
  }, [selected, focused.top, focused.height, limit, maxOffset]);
  return (
    <Box flexDirection="column">
      {maxOffset > 0 && <Text color={theme.textSubtle}>  ↑↓ more choices</Text>}
      <Box height={Math.min(height || limit, limit)} overflow="hidden" position="relative">
        <Box ref={contentRef} position="absolute" top={-Math.min(offset, maxOffset)} width="100%" flexDirection="column">
          {children}
        </Box>
      </Box>
    </Box>
  );
}

function answerText(field: QuestionField, answers: Answers): string {
  const value = answers[field.key];
  if (field.kind === 'text' && field.secret && value !== undefined) return '••••••••';
  if (field.kind === 'choice') {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const labels = values.filter(item => item !== field.other?.value)
      .map(item => field.options.find(option => option.value === item)?.label ?? String(item));
    const other = field.other && answers[field.other.key];
    return [...labels, ...(other ? [String(other)] : [])].join(', ') || 'Skipped';
  }
  return value === undefined ? 'Skipped' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
}

export function QuestionCard({ request, waiting, onAnswer, agentArrows = false }: {
  request: QuestionRequest;
  waiting: number;
  onAnswer: (answer: QuestionAnswer) => void;
  agentArrows?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [reviewSelected, setReviewSelected] = useState(request.fields.length);
  const [editingReview, setEditingReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const focusRef = useRef<DOMElement>(null);
  // The question spans the card, so it measures the room the choices have.
  const questionRef = useRef<DOMElement>(null);
  const { width: measured } = useBoxMetrics(questionRef);
  const { stdout } = useStdout();
  const reviewing = index === request.fields.length;
  const field = request.fields[index];
  const draft = field ? drafts[field.key] ?? EMPTY_DRAFT : EMPTY_DRAFT;
  const rows = field ? rowsOf(field) : [];
  const multiple = field?.kind === 'choice' && field.multiple;
  const typingOther = rows[draft.selected]?.action === 'other';
  const entryField = field?.kind === 'text' || field?.kind === 'number';
  const typing = typingOther || entryField;

  const updateDraft = (patch: Partial<Draft>) => {
    if (!field) return;
    setDrafts(current => ({ ...current, [field.key]: { ...current[field.key] ?? EMPTY_DRAFT, ...patch } }));
    setError(null);
  };
  const moveHighlight = (step: number) => updateDraft({ selected: (draft.selected + step + rows.length) % rows.length });
  const goTo = (next: number) => {
    if (reviewing && next < request.fields.length) setEditingReview(true);
    setIndex(next);
    setError(null);
    if (next === request.fields.length) setReviewSelected(request.fields.length);
  };
  const finish = (content: Answers) => {
    if (sent.current) return;
    sent.current = true;
    onAnswer({ action: 'accept', content });
  };
  const commit = (next: Answers) => {
    setAnswers(next);
    if (request.fields.length === 1) finish(next);
    else if (editingReview) {
      setEditingReview(false);
      goTo(request.fields.length);
    }
    else goTo(index + 1);
  };
  const withoutField = (): Answers => {
    const next = { ...answers };
    delete next[field.key];
    if (field.kind === 'choice' && field.other) delete next[field.other.key];
    return next;
  };
  const submitChoices = (custom?: string) => {
    if (field.kind !== 'choice') return;
    const minimum = Math.max(field.required ? 1 : 0, field.minimum ?? 0);
    if (!custom && (field.required || draft.picked.length > 0) && draft.picked.length < minimum) {
      setError(`Choose at least ${minimum} option${minimum === 1 ? '' : 's'}.`);
      return;
    }
    if (field.maximum !== undefined && draft.picked.length > field.maximum) {
      setError(`Choose at most ${field.maximum} option${field.maximum === 1 ? '' : 's'}.`);
      return;
    }
    const next = withoutField();
    if (draft.picked.length || field.required || custom) next[field.key] = [...draft.picked];
    if (custom && field.other) next[field.other.key] = custom;
    commit(next);
  };
  const submitEntry = () => {
    const value = draft.editor.text.trim();
    if (typingOther && field.kind === 'choice' && field.other) {
      if (!value) return setError('Enter your answer.');
      if (field.multiple) return submitChoices(value);
      const next = { ...withoutField(), [field.other.key]: value };
      if (field.other.value) next[field.key] = field.other.value;
      commit(next);
    } else if (field.kind === 'text' || field.kind === 'number') {
      if (!value) {
        if (field.required) return setError('Enter your answer.');
        return commit(withoutField());
      }
      if (field.kind === 'text') return commit({ ...answers, [field.key]: value });
      const number = Number(value);
      if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number))) {
        return setError(field.integer ? 'Enter a whole number.' : 'Enter a number.');
      }
      if (field.minimum !== undefined && number < field.minimum) return setError(`At least ${field.minimum}.`);
      if (field.maximum !== undefined && number > field.maximum) return setError(`At most ${field.maximum}.`);
      commit({ ...answers, [field.key]: number });
    }
  };
  // Highlighting "Other…" is all choosing it takes: its answer is typed there.
  const choose = (row: Row, rowIndex: number) => {
    updateDraft({ selected: rowIndex });
    if (row.action === 'continue') submitChoices();
    else if (row.action === 'skip') commit(withoutField());
    else if (multiple && typeof row.value === 'string') {
      const value = row.value;
      updateDraft({ picked: draft.picked.includes(value) ? draft.picked.filter(item => item !== value) : [...draft.picked, value] });
    } else if (row.action !== 'other') commit({ ...withoutField(), [field.key]: row.value! });
  };
  const edit = (change: InputEdit) => updateDraft({ editor: applyInputEdit(draft.editor, change) });

  usePaste(text => {
    if (typing && !reviewing) edit({ type: 'insert', text: text.replace(/\r\n?|\n/g, ' ') });
  });
  useInput((input, key) => {
    if (isKeyboardProtocolReport(input)) return;
    if (key.eventType === 'release' || (key.ctrl && input === 'c')) return;
    if (agentArrows && !key.ctrl && !key.meta && !key.shift && (key.leftArrow || key.rightArrow)) return;
    if (isForeignInput(input, key) || sent.current) return;
    if (key.escape) {
      sent.current = true;
      onAnswer({ action: 'decline' });
      return;
    }
    if (key.tab && key.shift) {
      if (index > 0) goTo(index - 1);
      return;
    }
    if (reviewing) {
      if (key.upArrow || key.downArrow) setReviewSelected(current => (current + (key.upArrow ? -1 : 1) + request.fields.length + 1) % (request.fields.length + 1));
      else if (key.return) reviewSelected === request.fields.length ? finish(answers) : goTo(reviewSelected);
      else if (!key.ctrl && !key.meta && /^[1-9]$/.test(input) && Number(input) <= request.fields.length) goTo(Number(input) - 1);
      return;
    }
    if (typing) {
      if (typingOther && (key.upArrow || key.downArrow)) moveHighlight(key.upArrow ? -1 : 1);
      else if (key.tab && multiple && !draft.editor.text.trim()) submitChoices();
      else if (key.return || key.tab) submitEntry();
      else if (inputEditForKey(input, key)) edit(inputEditForKey(input, key)!);
      else if (isTypedText(key)) edit({ type: 'insert', text: input });
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow) moveHighlight(key.upArrow ? -1 : 1);
    else if (key.leftArrow && index > 0) goTo(index - 1);
    else if (key.tab && multiple) submitChoices();
    else if (key.return || (multiple && input === ' ')) {
      const row = rows[draft.selected];
      if (row) choose(row, draft.selected);
    } else if (/^[1-9]$/.test(input) && Number(input) <= rows.length) choose(rows[Number(input) - 1], Number(input) - 1);
  });

  const { question, label } = reviewing ? { question: 'Review your answers', label: undefined } : questionText(request, field);
  const right = [request.fields.length > 1 ? reviewing ? 'Review' : `${index + 1} of ${request.fields.length}` : '', waiting > 0 ? `${waiting} more` : ''].filter(Boolean).join(' · ');
  const next = request.fields.length === 1 ? 'submit' : index === request.fields.length - 1 ? 'review' : 'next';
  const footer = reviewing ? '↑↓ edit · enter select · esc declines'
    : typingOther ? `↑↓ move · enter ${next}${index > 0 ? ' · shift+tab back' : ''} · esc declines`
      : typing ? `enter ${!field.required && !draft.editor.text.trim() ? 'skip' : next} · shift+tab back · esc declines`
        : multiple ? '↑↓ move · space toggle · tab continue · esc declines'
          : '↑↓ move · enter select · esc declines';

  // Only the highlighted option says more: beside the list when the card has
  // room for two columns, under the option when it does not. On "Other…" that
  // is where the user's own answer is typed.
  const width = measured || (stdout.columns ?? 80) - 6;
  const sideBySide = width >= SIDE_BY_SIDE_WIDTH && rows.some(row => row.description);
  const prefixOf = (row: Row, rowIndex: number) => row.action === 'continue' || row.action === 'skip' ? ''
    : `${rowIndex + 1}. ${multiple && !row.action ? draft.picked.includes(row.value as string) ? '[x] ' : '[ ] ' : ''}`;
  const listWidth = Math.min(Math.floor(width * 0.45),
    Math.max(20, 2 + Math.max(0, ...rows.map((row, rowIndex) => stringWidth(prefixOf(row, rowIndex) + row.label)))));
  const highlighted = rows[draft.selected];
  const detail = highlighted?.description || typingOther ? (
    <Box flexDirection="column">
      {highlighted.description ? <Text color={theme.textMuted} wrap="wrap">{highlighted.description}</Text> : null}
      {typingOther && <Entry editor={draft.editor} />}
    </Box>
  ) : null;
  const choices = field && !entryField && (
    <Choices key={field.key} selected={draft.selected} focusRef={focusRef}>
      {rows.map((row, rowIndex) => (
        <QuestionRow key={rowIndex} focusRef={draft.selected === rowIndex ? focusRef : undefined}
          active={draft.selected === rowIndex} label={row.label} prefix={prefixOf(row, rowIndex)}
          onChoose={() => choose(row, rowIndex)}>
          {!sideBySide && draft.selected === rowIndex && detail}
        </QuestionRow>
      ))}
    </Choices>
  );

  return (
    <FramedCard tone={theme.accent} title={[
      { text: '? ', color: theme.accent },
      ...questionTitle(request),
      ...(label ? [{ text: ` · ${terminalText(label)}`, color: theme.textMuted }] : []),
    ]} {...(right ? { right } : {})} footer={footer}>
      <Box ref={questionRef} flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text color={theme.text} bold wrap="wrap">{terminalText(question)}</Text>
        <Text color={theme.textMuted}>{reviewing ? 'Select an answer to change it, or submit below.'
          : multiple ? `Select all that apply · ${draft.picked.length} selected` : entryField ? 'Type your answer below.' : 'Choose one option.'}</Text>
      </Box>
      {reviewing ? (
        <Choices key="review" selected={reviewSelected} focusRef={focusRef}>
          {request.fields.map((item, itemIndex) => (
            <QuestionRow key={item.key} focusRef={reviewSelected === itemIndex ? focusRef : undefined}
              prefix={`${itemIndex + 1}. `} label={terminalText(questionText(request, item).label ?? item.title)}
              active={reviewSelected === itemIndex} onChoose={() => goTo(itemIndex)}>
              <Text color={theme.textMuted} wrap="wrap">{terminalText(answerText(item, answers))}</Text>
            </QuestionRow>
          ))}
          <QuestionRow focusRef={reviewSelected === request.fields.length ? focusRef : undefined}
            label="Submit answers" active={reviewSelected === request.fields.length} onChoose={() => finish(answers)} />
        </Choices>
      ) : entryField ? (
        <Box paddingLeft={2}>
          <Entry editor={draft.editor} secret={field.kind === 'text' && field.secret} />
        </Box>
      ) : sideBySide ? (
        <Box>
          <Box width={listWidth} flexShrink={0} flexDirection="column">{choices}</Box>
          <Box marginLeft={2} flexGrow={1} flexBasis={0} minWidth={0} flexDirection="column">{detail}</Box>
        </Box>
      ) : choices}
      {error && <Text color={theme.danger}>  {error}</Text>}
      {!reviewing && index > 0 && (
        <Box marginTop={1}>
          <QuestionRow label="Back" active={false} onChoose={() => goTo(index - 1)} />
        </Box>
      )}
    </FramedCard>
  );
}
