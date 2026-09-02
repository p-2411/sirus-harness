import { describe, expect, test } from 'bun:test';
import { rootTextRanges } from '../src/mentions';

describe('root mention text ranges', () => {
  test('returns only top-level prose paragraphs', () => {
    const markdown = [
      '@reviewer this is actionable',
      '',
      '> [!NOTE]',
      '> @reviewer this callout is an example',
      '',
      '- @reviewer this list item is an example',
      '',
      '| Agent | Example |',
      '| --- | --- |',
      '| reviewer | @reviewer |',
      '',
      '```text',
      '@reviewer this code is an example',
      '```',
      '',
      '# @reviewer this heading is not a request',
      '',
      'Final top-level paragraph.',
    ].join('\n');

    expect(rootTextRanges(markdown).map(range => range.text)).toEqual([
      '@reviewer this is actionable',
      'Final top-level paragraph.',
    ]);
  });

  test('excludes quoted examples and inline code within top-level prose', () => {
    const markdown = 'Examples: "@reviewer no", ‘@builder no’, \'don\'t ask @critic\', and `@verifier no`; @sirus yes.';
    const routableText = rootTextRanges(markdown).map(range => range.text).join('');

    expect(routableText).not.toContain('@reviewer');
    expect(routableText).not.toContain('@builder');
    expect(routableText).not.toContain('@verifier');
    expect(routableText).not.toContain('@critic');
    expect(routableText).toContain('@sirus yes');
  });
});
