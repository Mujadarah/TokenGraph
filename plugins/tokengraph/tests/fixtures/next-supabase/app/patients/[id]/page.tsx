import { PatientCard } from "@/components/PatientCard";
import { loadPatientSummary } from "@/services/patientService";

export default function PatientPage() {
  const patient = loadPatientSummary();
  return <PatientCard patient={patient} />;
}
