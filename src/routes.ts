/** Static decision-type -> tier table (from the jev-harness ledger mapping). */
export type RouteTarget = 'flash' | 'clef' | 'either'

export const ROUTE_TABLE: Readonly<Record<string, RouteTarget>> = {
  'shell-safety': 'flash',
  'outbound-leak': 'flash',
  'loop-detector': 'flash',
  'compact-advisor': 'flash',
  'promise-continue': 'flash',
  'failure-triage': 'flash',
  'read-budget': 'clef',
  'mcp-trim': 'clef',
  'memory-hygiene': 'clef',
  'injection-screen': 'clef',
  'mcp:ask_jev_file': 'clef',
  'mcp:ask_jev_files': 'clef',
  'mcp:ask_jev': 'clef',
  'mcp:pick_first_file': 'flash',
  'mcp:command-gate': 'flash',
  'screenshot-gate': 'flash',
  'deploy-preflight': 'either',
  'semantic-lint': 'either',
  'subagent-router': 'either',
}
