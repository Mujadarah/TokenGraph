export function PatientCard({ patient }: { patient: unknown }) {
  return <article>{String(patient)}</article>;
}
