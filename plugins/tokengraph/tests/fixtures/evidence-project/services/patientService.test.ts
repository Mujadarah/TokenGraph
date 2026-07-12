import { getPatient } from "./patientService";

describe("getPatient", () => {
  it("returns a tenant-scoped patient", async () => {
    expect((await getPatient("patient-1")).tenant_id).toBe("tenant-fixture");
  });
});
