export function PatientCard({ patient }: { patient: { name: string } }) {
  return `<article>${patient.name}</article>`;
}
