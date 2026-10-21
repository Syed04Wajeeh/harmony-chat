import type { ColumnType, Generated } from 'kysely';

export interface UsersTable {
  id: Generated<string>;
  login: string;
  display_name: string;
  avatar_url: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface Database {
  users: UsersTable;
}
