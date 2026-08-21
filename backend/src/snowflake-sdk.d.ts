/**
 * Minimal ambient declaration for `snowflake-sdk`, which ships no types.
 * Only the surface `snowflakeClient.ts` uses is declared; keeping it local
 * avoids adding an unapproved `@types/*` dependency.
 */
declare module "snowflake-sdk" {
  export interface ConnectionOptions {
    account: string;
    username: string;
    password?: string;
    authenticator?: string;
    privateKey?: string;
    privateKeyPass?: string;
    warehouse?: string;
    database?: string;
    schema?: string;
    role?: string;
    application?: string;
  }

  export interface ExecuteOptions {
    sqlText: string;
    binds?: unknown[];
    complete: (err: Error | undefined, stmt: unknown, rows: unknown[] | undefined) => void;
  }

  export interface Connection {
    connect(callback: (err: Error | undefined, conn: Connection) => void): void;
    execute(options: ExecuteOptions): void;
    destroy(callback: (err: Error | undefined) => void): void;
  }

  export function createConnection(options: ConnectionOptions): Connection;

  const snowflake: { createConnection: typeof createConnection };
  export default snowflake;
}
