export function requireTenant(userId: string, tenantId: string) {
  if (!userId || !tenantId) throw new Error("tenant authorization required");
  return { userId, tenantId };
}
