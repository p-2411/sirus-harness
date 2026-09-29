import { describe, expect, test } from 'bun:test';
import { approvalFields } from '../src/remote/push';

describe('lock-screen approval buttons', () => {
  test('answer with the first option of each kind, as the terminal picks it', () => {
    // A vendor can list a broader grant under a kind already offered, as
    // leaving plan mode with permissions bypassed after auto-accepting edits.
    const fields = approvalFields({ options: [
      { optionId: 'accept-edits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
      { optionId: 'once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
      { optionId: 'no', name: 'No', kind: 'reject_once' },
    ] });
    expect(fields.options).toEqual({ allow_always: 'accept-edits', allow_once: 'once', reject_once: 'no' });
    expect(fields.category).toBe('APPROVAL_ALWAYS');
  });

  test('offer Always Allow only when an option allows always', () => {
    const fields = approvalFields({ options: [
      { optionId: 'once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'never', name: 'No, and never ask', kind: 'reject_always' },
      { optionId: 'no', name: 'No', kind: 'reject_once' },
    ] });
    expect(fields.options).toEqual({ allow_once: 'once', reject_once: 'no' });
    expect(fields.category).toBe('APPROVAL');
  });

  test('offer no Allow when nothing allows once', () => {
    // An Allow button here asked for Face ID and then couldn't answer.
    const fields = approvalFields({ options: [
      { optionId: 'always', name: 'Yes, always', kind: 'allow_always' },
      { optionId: 'no', name: 'No', kind: 'reject_once' },
    ] });
    expect(fields.options).toEqual({ allow_always: 'always', reject_once: 'no' });
    expect(fields.category).toBe('APPROVAL:allow_always,reject_once');
  });

  test('offer no Deny when nothing rejects once', () => {
    const fields = approvalFields({ options: [
      { optionId: 'once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'never', name: 'No, and never ask', kind: 'reject_always' },
    ] });
    expect(fields.category).toBe('APPROVAL:allow_once');
  });

  test('offer no buttons when no option has a button', () => {
    const fields = approvalFields({ options: [
      { optionId: 'never', name: 'No, and never ask', kind: 'reject_always' },
    ] });
    expect(fields.options).toEqual({});
    expect(fields.category).toBeUndefined();
  });
});
