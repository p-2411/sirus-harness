// One question at a time, with drafts kept while the user moves back and
// forth. A form with several questions is reviewed before its answers go out.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Box, Text, useBoxMetrics, useInput, usePaste, useStdout, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { FramedCard } from './FramedCard';
import { applyInputEdit, type InputEdit, type InputState } from './editor';
import { useClickable } from '../interaction/clickable';
import { isMouseInput } from '../interaction/mouse';
import { isFocusInput } from '../terminal/window-focus';
import { describeRequester } from '../../agent_runtime/permissions/approvals';
import type { QuestionAnswer, QuestionField, QuestionRequest } from '../../agent_runtime/permissions/questions';

type Answers = Record<string, string | number | boolean | string[]>;
interface Draft {
  selected: number;
  picked: readonly string[];
  typingOther: boolean;
  editor: InputState;
}
const EMPTY_DRAFT: Draft = { selected: 0, picked: [], typingOther: false, editor: { text: '', cursor: 0 } };

interface Row {
  label: string;
  description?: string;
  value?: string | boolean;
  action?: 'other' | 'continue' | 'skip';
}

function rowsOf(field: QuestionField): Row[] {
  const rows: Row[] = field.kind === 'boolean'
    ? [{ label: 'Yes', value: true }, { label: 'No', value: false }]
    : field.kind === 'choice' ? [...field.options] : [];
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

function QuestionRow({ label, description, active, prefix, onChoose, focusRef }: {
  label: string;
  description?: string;
  active: boolean;
  prefix?: string;
  onChoose: () => void;
  focusRef?: RefObject<DOMElement | null>;
}) {
  const ref = useRef<DOMElement>(null);
  const hovered = useClickable(ref, onChoose);
  return (
    <Box ref={focusRef} flexShrink={0} width="100%">
      <Box ref={ref} width="100%">
        <Box width={2} flexShrink={0}><Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text></Box>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
          <Text color={active || hovered ? theme.highlight : theme.text} bold={active} wrap="wrap">{prefix}{label}</Text>
          {description && <Text color={theme.textMuted} wrap="wrap">{description}</Text>}
        </Box>
      </Box>
    </Box>
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

export function QuestionCard({ request, waiting, onAnswer }: {
  request: QuestionRequest;
  waiting: number;
  onAnswer: (answer: QuestionAnswer) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [reviewSelected, setReviewSelected] = useState(request.fields.length);
  const [editingReview, setEditingReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const focusRef = useRef<DOMElement>(null);
  const reviewing = index === request.fields.length;
  const field = request.fields[index];
  const draft = field ? drafts[field.key] ?? EMPTY_DRAFT : EMPTY_DRAFT;
  const rows = field ? rowsOf(field) : [];
  const multiple = field?.kind === 'choice' && field.multiple;
  const typing = draft.typingOther || field?.kind === 'text' || field?.kind === 'number';

  const updateDraft = (patch: Partial<Draft>) => {
    if (!field) return;
    setDrafts(current => ({ ...current, [field.key]: { ...current[field.key] ?? EMPTY_DRAFT, ...patch } }));
    setError(null);
  };
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
    if (draft.typingOther && field.kind === 'choice' && field.other) {
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
  const choose = (row: Row, rowIndex: number) => {
    updateDraft({ selected: rowIndex });
    if (row.action === 'other') updateDraft({ typingOther: true });
    else if (row.action === 'continue') submitChoices();
    else if (row.action === 'skip') commit(withoutField());
    else if (multiple && typeof row.value === 'string') {
      const value = row.value;
      updateDraft({ picked: draft.picked.includes(value) ? draft.picked.filter(item => item !== value) : [...draft.picked, value] });
    } else commit({ ...withoutField(), [field.key]: row.value! });
  };
  const edit = (change: InputEdit) => updateDraft({ editor: applyInputEdit(draft.editor, change) });

  usePaste(text => {
    if (typing && !reviewing) edit({ type: 'insert', text: text.replace(/\r\n?|\n/g, ' ') });
  });
  useInput((input, key) => {
    if (isMouseInput(input) || isFocusInput(input) || key.escape || sent.current
      || (key.meta && (key.upArrow || key.downArrow))) return;
    if (key.tab && key.shift) {
      if (index > 0) goTo(index - 1);
      else if (draft.typingOther) updateDraft({ typingOther: false });
      return;
    }
    if (reviewing) {
      if (key.upArrow || key.downArrow) setReviewSelected(current => (current + (key.upArrow ? -1 : 1) + request.fields.length + 1) % (request.fields.length + 1));
      else if (key.return) reviewSelected === request.fields.length ? finish(answers) : goTo(reviewSelected);
      else if (!key.ctrl && !key.meta && /^[1-9]$/.test(input) && Number(input) <= request.fields.length) goTo(Number(input) - 1);
      return;
    }
    const isBackspace = key.backspace || key.delete;
    if (typing) {
      if (key.return || key.tab) submitEntry();
      else if (key.ctrl && input === 'u') edit({ type: 'clear' });
      else if ((key.ctrl && input === 'w') || (key.meta && isBackspace)) edit({ type: 'delete-word-backward' });
      else if (isBackspace) edit({ type: 'backspace' });
      else if (key.leftArrow || key.rightArrow) edit({ type: key.leftArrow ? 'left' : 'right' });
      else if (key.home || key.end) updateDraft({ editor: { ...draft.editor, cursor: key.home ? 0 : draft.editor.text.length } });
      else if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) edit({ type: 'insert', text: input });
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow) updateDraft({ selected: (draft.selected + (key.upArrow ? -1 : 1) + rows.length) % rows.length });
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
  const footer = reviewing ? '↑↓ edit · enter select · esc cancels'
    : typing ? `enter ${!field.required && !draft.typingOther && !draft.editor.text.trim() ? 'skip' : next} · shift+tab back · esc cancels`
      : multiple ? '↑↓ move · space toggle · tab continue · esc cancels'
        : '↑↓ move · enter select · esc cancels';
  const secret = field?.kind === 'text' && field.secret;
  const displayText = (text: string) => secret ? '•'.repeat([...text].length) : text;

  return (
    <FramedCard tone={theme.accent} title={[
      { text: '? ', color: theme.accent },
      { text: describeRequester(request.requester), color: theme.accent, bold: true },
      { text: ' asks' },
      ...(label ? [{ text: ` · ${label}`, color: theme.textMuted }] : []),
    ]} {...(right ? { right } : {})} footer={footer}>
      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text color={theme.text} bold wrap="wrap">{question}</Text>
        <Text color={theme.textMuted}>{reviewing ? 'Select an answer to change it, or submit below.'
          : multiple ? `Select all that apply · ${draft.picked.length} selected` : typing ? 'Type your answer below.' : 'Choose one option.'}</Text>
      </Box>
      {reviewing ? (
        <Choices key="review" selected={reviewSelected} focusRef={focusRef}>
          {request.fields.map((item, itemIndex) => (
            <QuestionRow key={item.key} focusRef={reviewSelected === itemIndex ? focusRef : undefined}
              prefix={`${itemIndex + 1}. `} label={questionText(request, item).label ?? item.title} description={answerText(item, answers)}
              active={reviewSelected === itemIndex} onChoose={() => goTo(itemIndex)} />
          ))}
          <QuestionRow focusRef={reviewSelected === request.fields.length ? focusRef : undefined}
            label="Submit answers" active={reviewSelected === request.fields.length} onChoose={() => finish(answers)} />
        </Choices>
      ) : typing ? (
        <Box paddingLeft={2} flexDirection="column">
          {draft.typingOther && <Text color={theme.textMuted}>Your answer</Text>}
          <Text wrap="wrap">
            <Text color={theme.text}>{displayText(draft.editor.text.slice(0, draft.editor.cursor))}</Text>
            <Text color={theme.accent}>▌</Text>
            <Text color={theme.text}>{displayText(draft.editor.text.slice(draft.editor.cursor))}</Text>
          </Text>
        </Box>
      ) : (
        <Choices key={field.key} selected={draft.selected} focusRef={focusRef}>
          {rows.map((row, rowIndex) => (
            <QuestionRow key={rowIndex} focusRef={draft.selected === rowIndex ? focusRef : undefined}
              active={draft.selected === rowIndex} label={row.label} description={row.description}
              prefix={row.action === 'continue' || row.action === 'skip' ? '' : `${rowIndex + 1}. ${multiple && !row.action ? draft.picked.includes(row.value as string) ? '[x] ' : '[ ] ' : ''}`}
              onChoose={() => choose(row, rowIndex)} />
          ))}
        </Choices>
      )}
      {error && <Text color={theme.danger}>  {error}</Text>}
      {!reviewing && (draft.typingOther || index > 0) && (
        <Box marginTop={1}>
          <QuestionRow label={draft.typingOther ? 'Back to options' : 'Back'} active={false}
            onChoose={() => draft.typingOther ? updateDraft({ typingOther: false }) : goTo(index - 1)} />
        </Box>
      )}
    </FramedCard>
  );
}
