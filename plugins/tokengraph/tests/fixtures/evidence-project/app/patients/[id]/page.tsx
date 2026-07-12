import { PatientCard } from "../../../components/PatientCard";
import { getPatient } from "../../../services/patientService";

export async function PatientPage({ id }: { id: string }) {
  return PatientCard({ patient: await getPatient(id) });
}
