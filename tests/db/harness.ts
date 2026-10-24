import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

export const DEMO_EMAILS = [
  'inst.nirmala@aicasa-demo.test',
  'inst.sahyadri@aicasa-demo.test',
  'univ.deccan@aicasa-demo.test',
  'inst.coromandel@aicasa-demo.test',
  'officer.wr.scrutiny@aicasa-demo.test',
  'officer.wr.evc@aicasa-demo.test',
  'officer.wr.compliance@aicasa-demo.test',
  'officer.sr@aicasa-demo.test',
  'admin.national@aicasa-demo.test',
  'admin.wr@aicasa-demo.test',
] as const;
export type DemoEmail = (typeof DEMO_EMAILS)[number] | string;

export interface TestDb {
  db: PGlite;
  ids: Record<string, string>;
  /** Run SQL as a signed-in user, with RLS applied (role "authenticated"). */
  as<T = Record<string, unknown>>(email: DemoEmail, sql: string, params?: unknown[]): Promise<T[]>;
  /** Run SQL as the service role (used by Edge Functions / scripts). */
  service<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run SQL as the database owner (test setup only). */
  owner<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function migrationFiles(): string[] {
  const dir = path.join(root, 'supabase/migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(dir, f));
}

export async function createTestDb(opts: { seedCases?: boolean } = {}): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(readFileSync(path.join(root, 'tests/db/supabase-shim.sql'), 'utf8'));
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${path.basename(file)} failed: ${(e as Error).message}`);
    }
  }
  try {
    await db.exec(readFileSync(path.join(root, 'supabase/seed.sql'), 'utf8'));
  } catch (e) {
    throw new Error(`seed.sql failed: ${(e as Error).message}`);
  }

  const ids: Record<string, string> = {};
  for (const email of DEMO_EMAILS) {
    const r = await db.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, '{"is_demo": true}') returning id`,
      [email],
    );
    ids[email] = r.rows[0].id;
  }
  await db.query('select public.provision_demo_access()');
  if (opts.seedCases !== false) {
    const r = await db.query<{ r: { ok?: boolean } }>(`select public.seed_demo_cases('{}'::jsonb) as r`);
    if (!r.rows[0].r?.ok) throw new Error('seed_demo_cases did not complete: ' + JSON.stringify(r.rows[0].r));
  }

  async function run<T>(claims: Record<string, unknown> | null, role: string | null, sql: string, params?: unknown[]) {
    await db.exec(`select set_config('request.jwt.claims', '${claims ? JSON.stringify(claims) : ''}', false);
                   select set_config('request.jwt.claim.sub', '${(claims?.sub as string) ?? ''}', false);
                   select set_config('request.jwt.claim.role', '${(claims?.role as string) ?? ''}', false);`);
    if (role) await db.exec(`set role ${role}`);
    try {
      const r = await db.query<T>(sql, params as never);
      return r.rows;
    } finally {
      await db.exec(`reset role;
                     select set_config('request.jwt.claims', '', false);
                     select set_config('request.jwt.claim.sub', '', false);
                     select set_config('request.jwt.claim.role', '', false);`);
    }
  }

  return {
    db,
    ids,
    as: (email, sql, params) => {
      const sub = ids[email];
      if (!sub) throw new Error('Unknown test user ' + email);
      return run(
        { sub, role: 'authenticated' },
        'authenticated',
        sql,
        params,
      );
    },
    service: (sql, params) => run({ role: 'service_role' }, 'service_role', sql, params),
    owner: (sql, params) => run(null, null, sql, params),
  };
}

export async function addUser(t: TestDb, email: string): Promise<string> {
  const r = await t.db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [email]);
  t.ids[email] = r.rows[0].id;
  return r.rows[0].id;
}

/** Expect a SQL call to fail with a message matching the pattern. */
export async function expectSqlError(p: Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (!pattern.test(msg)) throw new Error(`Expected error matching ${pattern} but got: ${msg}`);
    return msg;
  }
  throw new Error(`Expected error matching ${pattern} but the call succeeded`);
}
