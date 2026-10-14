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
  ask_jev_file: 'clef',
  'semantic-lint': 'either',
  'subagent-router': 'either',
}
