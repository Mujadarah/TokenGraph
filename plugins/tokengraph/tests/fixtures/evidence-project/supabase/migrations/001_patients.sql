create table public.patients (
  id uuid primary key,
  tenant_id uuid not null,
  name text not null
);

alter table public.patients enable row level security;
create policy "patients tenant select" on public.patients
  for select to authenticated
  using (tenant_id = auth.uid());
create index patients_tenant_id_idx on public.patients (tenant_id);
