create table public.audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);

alter table public.audit_events enable row level security;
create policy "audit tenant select" on public.audit_events
  for select to authenticated using (tenant_id = auth.uid());
