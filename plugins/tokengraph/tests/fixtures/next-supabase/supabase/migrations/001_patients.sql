create table public.patients (
  id uuid primary key,
  tenant_id uuid not null,
  full_name text not null,
  archived_at timestamptz
);

create policy "tenant can read active patients"
on public.patients
for select
to authenticated
using (tenant_id = auth.uid() and archived_at is null);

create materialized view public.patient_rollups
as select tenant_id, count(*) from public.patients group by tenant_id;
