export type FeedbackKind = 'info' | 'success' | 'error';

export interface Feedback {
  kind: FeedbackKind;
  text: string;
  showIcon?: boolean;
}
