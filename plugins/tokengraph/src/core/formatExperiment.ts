import { estimateTokens } from "./token.js";

export type ResponseFormat = "json" | "tabular";

export interface FormatObservation {
  id: string;
  fields: Record<string, string | number | boolean | null>;
  requiredFields: string[];
}

export interface FormatExperimentResult {
  jsonTokens: number;
  tabularTokens: number;
  jsonQuality: number;
  tabularQuality: number;
  defaultFormat: ResponseFormat;
  reason: string;
}

function json(value: unknown): string { return JSON.stringify(value); }

export function serializeResponseFormat(observations: FormatObservation[], format: ResponseFormat): string {
  if (format === "json") return json(observations);
  const keys = [...new Set(observations.flatMap((observation) => Object.keys(observation.fields)))].sort();
  return [keys.join("\t"), ...observations.map((observation) => keys.map((key) => String(observation.fields[key] ?? "")).join("\t"))].join("\n");
}

function quality(observations: FormatObservation[], format: ResponseFormat): number {
  const body = serializeResponseFormat(observations, format);
  let preserved = 0;
  let total = 0;
  for (const observation of observations) for (const field of observation.requiredFields) {
    total += 1;
    const value = String(observation.fields[field] ?? "");
    if (format === "tabular" && /[\t\r\n]/.test(value)) continue;
    if (body.includes(value)) preserved += 1;
  }
  return total ? preserved / total : 1;
}

export function evaluateFormatExperiment(observations: FormatObservation[]): FormatExperimentResult {
  const jsonText = serializeResponseFormat(observations, "json");
  const tabularText = serializeResponseFormat(observations, "tabular");
  const jsonTokens = estimateTokens(jsonText);
  const tabularTokens = estimateTokens(tabularText);
  const jsonQuality = quality(observations, "json");
  const tabularQuality = quality(observations, "tabular");
  const tabularWins = tabularTokens < jsonTokens && tabularQuality > jsonQuality;
  return { jsonTokens, tabularTokens, jsonQuality, tabularQuality, defaultFormat: tabularWins ? "tabular" : "json", reason: tabularWins ? "tabular reduced tokens without quality loss" : "tabular did not improve both token usage and quality" };
}
