declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, opts?: { readonly?: boolean })
    query(sql: string): { all(...args: unknown[]): any[] }
    close(): void
  }
}
