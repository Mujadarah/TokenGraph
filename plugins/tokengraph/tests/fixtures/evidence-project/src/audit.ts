export function auditEvent(action: string, subject: string) {
  return { action, subject, recorded: true };
}
