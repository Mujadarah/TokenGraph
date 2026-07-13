import * as z from "zod/v4";

export { compactCompressionEnvelope, compactModeEnvelope, compactPrepareEnvelope } from "./compactResponses.js";

export function compactToolResultEnvelope<T extends object>(structuredContent: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] };
}

const tokenSavingProfileSchema = z.enum(["conservative", "balanced", "aggressive"]);
const contextCompressionKindSchema = z.enum(["prompt", "memory", "diff", "sql", "wiki", "mixed"]);
const compactResponseFields = {
  constraints: z.array(z.string().min(1)).optional(),
  responseMode: z.enum(["compact", "verbose"]).optional()
};

export const prepareContextInputSchema = z.object({
  root: z.string().optional(), task: z.string().min(3), profile: tokenSavingProfileSchema.optional(),
  maxTokens: z.number().int().min(1).optional(), allowRawReads: z.boolean().optional(), ...compactResponseFields, refreshIndex: z.boolean().default(true),
  host: z.enum(["codex", "claude", "unknown"]).optional()
});

export const queryContextInputSchema = z.object({
  taskId: z.string().uuid(), root: z.string().optional(), mode: z.enum(["overview", "search", "symbol", "sql", "wiki"]),
  query: z.string().min(1).optional(), target: z.string().min(1).optional(), slug: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(), ...compactResponseFields
}).superRefine((input, context) => {
  if ((input.mode === "search" || input.mode === "sql") && !input.query) context.addIssue({ code: "custom", message: `${input.mode} mode requires query.` });
  if (input.mode === "symbol" && !input.target) context.addIssue({ code: "custom", message: "symbol mode requires target." });
});

export const compressInputSchema = z.object({
  taskId: z.string().uuid(), root: z.string().optional(), mode: z.enum(["output", "context"]),
  kind: z.enum(["test", "build", "install", "diff", "log"]).optional(), text: z.string().optional(), maxLines: z.number().int().min(1).max(200).optional(),
  task: z.string().min(1).optional(), contentKind: contextCompressionKindSchema.optional(),
  preserveRawReferences: z.boolean().optional(), ...compactResponseFields
}).superRefine((input, context) => {
  if (input.mode === "output" && (!input.kind || input.text === undefined)) context.addIssue({ code: "custom", message: "output mode requires kind and text." });
  if (input.mode === "context" && (!input.task || !input.contentKind)) context.addIssue({ code: "custom", message: "context mode requires task and contentKind." });
});

export const recallInputSchema = z.object({
  taskId: z.string().uuid(), root: z.string().optional(), mode: z.enum(["recall", "review"]),
  query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), audit: z.boolean().optional(), ...compactResponseFields
});

export const analyzeInputSchema = z.object({
  taskId: z.string().uuid(), root: z.string().optional(), mode: z.enum(["failure", "risk", "architecture"]),
  kind: z.enum(["test", "build", "runtime", "install", "log"]).optional(), text: z.string().min(1).optional(),
  changedFiles: z.array(z.string().min(1)).min(1).optional(), diffSummary: z.string().optional(), task: z.string().optional(),
  files: z.array(z.string()).optional(), ...compactResponseFields
}).superRefine((input, context) => {
  if (input.mode === "failure" && (!input.kind || !input.text)) context.addIssue({ code: "custom", message: "failure mode requires kind and text." });
  if (input.mode === "risk" && !input.changedFiles) context.addIssue({ code: "custom", message: "risk mode requires changedFiles." });
});

export function benchmarkMcpInputSchemas(): Record<"planner" | "tracer" | "risk" | "compressor" | "wiki" | "memory", unknown> {
  const inputSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
  return {
    planner: inputSchema(prepareContextInputSchema), tracer: inputSchema(analyzeInputSchema), risk: inputSchema(analyzeInputSchema),
    compressor: inputSchema(compressInputSchema), wiki: inputSchema(queryContextInputSchema), memory: inputSchema(recallInputSchema)
  };
}
