/**
 * Which tools mean what.
 *
 * Three name sets and nothing else: they are the vocabulary the rest of
 * `detect/` reads, so they live alone where a reviewer can check the whole list
 * against the Harness's tool catalogue in one glance.
 */

/** Search-shaped tools. None of them expose bytes, so they render as elapsed time. */
export const SEARCH_TOOLS = new Set([
  'web_search',
  'advanced_search',
  'multi_search',
  'research',
  'platform_search',
  'video_search',
  'domain_search',
  'free_search_test',
])

/** Single-page fetches: start and end only, no intermediate progress. */
export const FETCH_TOOLS = new Set(['web_fetch'])

/** Tools whose first argument is a shell command line we may be able to parse. */
export const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal_send'])
