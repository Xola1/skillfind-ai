# Supabase migrations

Save `.sql` files in this folder while the VS Code task `Supabase: watch SQL migrations` is running.

Each save is applied through Codex and the configured Supabase MCP server using `apply_migration`.

Keep migrations idempotent while testing, for example:

```sql
create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  created_at timestamptz not null default now()
);
```
