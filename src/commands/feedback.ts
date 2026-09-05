export type FeedbackKind = 'info' | 'success' | 'error';

export interface Feedback {
  kind: FeedbackKind;
  text: string;
  showIcon?: boolean;
  // Long output borrows the history area instead of sitting above the input.
  panel?: boolean;
}
