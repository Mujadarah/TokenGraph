import { auditEvent } from "../src/audit";

export async function getPatient(id: string) {
  auditEvent("patient.read", id);
  return { id, name: "Fixture Patient", tenant_id: "tenant-fixture" };
}
