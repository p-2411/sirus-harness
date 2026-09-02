import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { Markdown } from '../../src/frontend/markdown/Markdown';

function render(markdown: string): string {
  return stripAnsi(renderToString(<Markdown>{markdown}</Markdown>, { columns: 80 }));
}

describe('terminal markdown renderer', () => {
  test('renders inline formatting without source markers', () => {
    const output = render('Use **bold**, *emphasis*, and `code`.');

    expect(output).toContain('Use bold, emphasis, and  code .');
    expect(output).not.toContain('**');
  });

  test('renders common block constructs', () => {
    const output = render([
      '# Heading',
      '',
      '- first',
      '- second',
      '',
      '> quoted',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n'));

    expect(output).toContain('Heading');
    expect(output).toContain('• first');
    expect(output).toContain('• second');
    expect(output).toContain('quoted');
    expect(output).toContain('ts');
    expect(output).toContain('const value = 1;');
  });

  test('renders GFM tables and links in a terminal-friendly form', () => {
    const output = render([
      '| Name | Value |',
      '| --- | --- |',
      '| memory | [docs](https://example.com) |',
    ].join('\n'));

    expect(output).toContain('Name');
    expect(output).toContain('memory');
    expect(output).toContain('docs');
    expect(output).toContain('https://example.com');
  });

  test('accepts incomplete markdown while the user is typing', () => {
    expect(() => render('unfinished **bold and `code')).not.toThrow();
  });

  test('preserves mentions through inline Markdown rendering', () => {
    const output = render('Ask **@reviewer** and @sirus.');
    expect(output).toContain('Ask @reviewer and @sirus.');
  });
});
