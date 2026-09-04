import type { ToolCallBlock, ToolResultBlock } from '../types';

// Sirus never searches or fetches the web itself. Each runtime brings its own
// web capability (the Anthropic API's web_search and web_fetch server tools,
// the OpenAI Responses API's web_search tool, Claude Code's WebSearch and
// WebFetch, Codex's web search) and executes it on the model's behalf. The
// providers translate whatever they observe into these two tool names, so the
// transcript, persistence, and the UI see one shape regardless of runtime.

export const WEB_SEARCH_TOOL = 'WebSearch';
export const FETCH_URL_TOOL = 'FetchURL';

export interface WebSearchArguments {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface FetchUrlArguments {
  url: string;
  // What the runtime was asked to take from the page: Claude Code's WebFetch
  // summarises against a prompt, OpenAI's find_in_page searches for a pattern.
  prompt?: string;
}

export interface WebSearchHit {
  url: string;
  title?: string;
  // Page freshness as reported by the runtime, when it reports one.
  age?: string;
}

export interface WebSearchOutcome {
  hits: WebSearchHit[];
  // Prose the runtime produced about the results (Claude Code summarises them).
  summary?: string;
  // Explains an empty hit list when the runtime ran the search but does not
  // expose what it read.
  note?: string;
  error?: string;
}

export interface FetchUrlOutcome {
  title?: string;
  content?: string;
  note?: string;
  error?: string;
}

// Fetched pages can run to megabytes; the transcript keeps enough to be
// useful in later turns without dominating them.
export const FETCH_CONTENT_LIMIT = 100_000;

export function isWebTool(name: string): boolean {
  return name === WEB_SEARCH_TOOL || name === FETCH_URL_TOOL;
}

export function webSearchCall(id: string, args: WebSearchArguments): ToolCallBlock {
  return { type: 'tool_call', id, name: WEB_SEARCH_TOOL, arguments: compact(args) };
}

export function fetchUrlCall(id: string, args: FetchUrlArguments): ToolCallBlock {
  return { type: 'tool_call', id, name: FETCH_URL_TOOL, arguments: compact(args) };
}

export function webSearchResult(call: ToolCallBlock, outcome: WebSearchOutcome): ToolResultBlock {
  const query = String(call.arguments.query ?? '');
  if (outcome.error) {
    return result(call, `Web search for ${JSON.stringify(query)} failed: ${outcome.error}`, true);
  }

  const lines: string[] = [];
  const count = outcome.hits.length;
  lines.push(`Web search results for ${JSON.stringify(query)}${count > 0 ? ` (${count} ${count === 1 ? 'result' : 'results'})` : ''}:`);
  outcome.hits.forEach((hit, index) => {
    const age = hit.age ? ` (${hit.age})` : '';
    if (hit.title && hit.title !== hit.url) {
      lines.push(`${index + 1}. ${hit.title}${age}`, `   ${hit.url}`);
    } else {
      lines.push(`${index + 1}. ${hit.url}${age}`);
    }
  });
  if (outcome.summary?.trim()) lines.push('', outcome.summary.trim());
  if (outcome.note) lines.push('', outcome.note);
  if (count === 0 && !outcome.summary?.trim() && !outcome.note) lines.push('No results.');
  return result(call, lines.join('\n'), false);
}

export function fetchUrlResult(call: ToolCallBlock, outcome: FetchUrlOutcome): ToolResultBlock {
  const url = String(call.arguments.url ?? '');
  if (outcome.error) {
    return result(call, `Fetching ${url} failed: ${outcome.error}`, true);
  }

  const lines: string[] = [`Fetched ${url}`];
  if (outcome.title) lines.push(`Title: ${outcome.title}`);
  if (outcome.content !== undefined) lines.push('', truncate(outcome.content));
  if (outcome.note) lines.push('', outcome.note);
  return result(call, lines.join('\n'), false);
}

function truncate(content: string): string {
  if (content.length <= FETCH_CONTENT_LIMIT) return content;
  const omitted = content.length - FETCH_CONTENT_LIMIT;
  return `${content.slice(0, FETCH_CONTENT_LIMIT)}\n… [truncated ${omitted} characters]`;
}

function result(call: ToolCallBlock, text: string, isError: boolean): ToolResultBlock {
  return { type: 'tool_result', callId: call.id, result: text, isError };
}

// Optional arguments the runtime did not set stay out of the recorded call.
function compact(args: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}
