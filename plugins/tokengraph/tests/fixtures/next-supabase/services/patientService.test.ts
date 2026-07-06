import { loadPatientSummary } from "./patientService";

test("loads patient summary", () => {
  expect(loadPatientSummary()).toMatchObject({ fullName: "Example Patient" });
});
