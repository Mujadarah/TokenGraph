const capabilityBrand = new WeakSet<object>();

let processCapability: LegacyRuntimeShutdownCapability | undefined;

export interface LegacyRuntimeShutdownCapability {
  /** The capability is intentionally opaque and has no serializable state. */
  readonly __legacyRuntimeShutdownCapability?: never;
}

export interface LegacyRuntimeActivationStatus {
  readonly activated: boolean;
}

export class LegacyRuntimeActivationError extends Error {
  readonly code = "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED" as const;

  constructor() {
    super("Legacy TokenGraph runtime shutdown has not been confirmed for this process.");
    this.name = "LegacyRuntimeActivationError";
  }
}

export function activateLegacyRuntimeShutdown(input: {
  readonly confirmedNoLegacyTokenGraphProcesses: true;
}): LegacyRuntimeShutdownCapability {
  if (input === null || typeof input !== "object" || input.confirmedNoLegacyTokenGraphProcesses !== true) {
    throw new LegacyRuntimeActivationError();
  }
  if (processCapability !== undefined) return processCapability;
  const capability = Object.freeze({}) as LegacyRuntimeShutdownCapability;
  capabilityBrand.add(capability);
  processCapability = capability;
  return capability;
}

export function getLegacyRuntimeActivationStatus(): LegacyRuntimeActivationStatus {
  return Object.freeze({ activated: processCapability !== undefined });
}

export function isLegacyRuntimeShutdownCapability(
  value: LegacyRuntimeShutdownCapability | undefined
): value is LegacyRuntimeShutdownCapability {
  return typeof value === "object" && value !== null && capabilityBrand.has(value);
}

export function requireLegacyRuntimeShutdownCapability(): LegacyRuntimeShutdownCapability {
  if (processCapability === undefined) throw new LegacyRuntimeActivationError();
  return processCapability;
}
