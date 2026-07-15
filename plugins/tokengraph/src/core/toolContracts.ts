import * as z from "zod/v4";

export { compactCompressionEnvelope, compactModeEnvelope, compactPrepareEnvelope } from "./compactResponses.js";

export function compactToolResultEnvelope<T extends object>(structuredContent: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] };
}

const tokenSavingProfileSchema = z.enum(["conservative", "balanced", "aggressive"]);
const contextCompressionKindSchema = z.enum(["prompt", "memory", "diff", "sql", "wiki", "mixed"]);
const taskIdSchema = z.string().min(1);
const routingFields = {
  knownArtifacts: z.array(z.string().min(1)).max(100).optional(),
  routingOverride: z.enum(["auto", "force-on", "force-bypass"]).optional()
};
const compactResponseFields = {
  constraints: z.array(z.string().min(1)).optional(),
  responseMode: z.enum(["compact", "verbose"]).optional(),
  ...routingFields
};

export const prepareContextInputSchema = z.object({
  root: z.string().optional(), task: z.string().min(3), profile: tokenSavingProfileSchema.optional(),
  maxTokens: z.number().int().min(1).optional(), allowRawReads: z.boolean().optional(), ...compactResponseFields, refreshIndex: z.boolean().default(true),
  host: z.enum(["codex", "claude", "unknown"]).optional()
});

export const queryContextInputSchema = z.object({
  taskId: taskIdSchema.optional(), root: z.string().optional(), mode: z.enum(["overview", "search", "symbol", "sql", "wiki", "artifact", "run", "slice"]),
  query: z.string().min(1).optional(), target: z.string().min(1).optional(), slug: z.string().min(1).optional(), artifactHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  runId: taskIdSchema.optional(), test: z.string().min(1).optional(), file: z.string().min(1).optional(), errorClass: z.string().min(1).optional(),
  startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  limit: z.number().int().min(1).max(50).optional(), ...compactResponseFields
}).superRefine((input, context) => {
  if ((input.mode === "search" || input.mode === "sql") && !input.query) context.addIssue({ code: "custom", message: `${input.mode} mode requires query.` });
  if (input.mode === "symbol" && !input.target) context.addIssue({ code: "custom", message: "symbol mode requires target." });
  if (input.mode === "artifact" && !input.artifactHash) context.addIssue({ code: "custom", path: ["artifactHash"], message: "artifact mode requires artifactHash." });
  if (input.mode === "run") {
    if (!input.runId) context.addIssue({ code: "custom", path: ["runId"], message: "run mode requires runId." });
    if ([input.test, input.file, input.errorClass].filter((value) => value !== undefined).length !== 1) {
      context.addIssue({ code: "custom", message: "run mode requires exactly one of test, file, or errorClass." });
    }
  }
  if (input.mode === "slice" && (!input.file || input.startLine === undefined || input.endLine === undefined || !input.contentHash)) {
    context.addIssue({ code: "custom", message: "slice mode requires file, startLine, endLine, and contentHash." });
  }
});

export const compressInputSchema = z.object({
  taskId: taskIdSchema.optional(), root: z.string().optional(), mode: z.enum(["output", "context"]),
  kind: z.enum(["test", "build", "install", "diff", "log"]).optional(), text: z.string().optional(), maxLines: z.number().int().min(1).max(200).optional(),
  task: z.string().min(1).optional(), contentKind: contextCompressionKindSchema.optional(),
  preserveRawReferences: z.boolean().optional(), ...compactResponseFields
}).superRefine((input, context) => {
  if (input.mode === "output" && (!input.kind || input.text === undefined)) context.addIssue({ code: "custom", message: "output mode requires kind and text." });
  if (input.mode === "context" && (!input.task || !input.contentKind)) context.addIssue({ code: "custom", message: "context mode requires task and contentKind." });
});

export const recallInputSchema = z.object({
  taskId: taskIdSchema.optional(), root: z.string().optional(), mode: z.enum(["recall", "review"]),
  query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), audit: z.boolean().optional(), ...compactResponseFields
});

export const analyzeInputSchema = z.object({
  taskId: taskIdSchema.optional(), root: z.string().optional(), mode: z.enum(["failure", "risk", "architecture"]),
  kind: z.enum(["test", "build", "runtime", "install", "log"]).optional(), text: z.string().min(1).optional(),
  changedFiles: z.array(z.string().min(1)).min(1).optional(), diffSummary: z.string().optional(), task: z.string().optional(),
  files: z.array(z.string()).optional(), ...compactResponseFields
}).superRefine((input, context) => {
  if (input.mode === "failure" && (!input.kind || !input.text)) context.addIssue({ code: "custom", message: "failure mode requires kind and text." });
  if (input.mode === "risk" && !input.changedFiles) context.addIssue({ code: "custom", message: "risk mode requires changedFiles." });
});

export const setupInputSchema = z.object({});

export const proposeKnowledgeInputSchema = z.object({
  taskId: taskIdSchema, root: z.string().optional(), action: z.enum(["propose", "list", "approve", "reject"]),
  type: z.enum(["wiki", "memory", "skill"]).optional(), title: z.string().min(1).optional(), rationale: z.string().min(1).optional(),
  proposedContent: z.string().min(1).optional(), sourceFingerprints: z.array(z.string()).min(1).optional(), affectedIdentifiers: z.array(z.string()).min(1).optional(),
  sources: z.array(z.object({ kind: z.enum(["path", "id"]), sourceId: z.string().min(1), fingerprint: z.string().min(1) })).min(1).optional(),
  affectedTargets: z.object({ wikiPages: z.array(z.string()).optional(), memories: z.array(z.string()).optional(), skills: z.array(z.string()).optional() }).optional(),
  conflictNotes: z.array(z.string()).optional(), expiresAt: z.string().optional(),
  status: z.enum(["proposed", "approved", "rejected", "expired"]).optional(), id: z.string().min(1).optional(), reason: z.string().optional(),
  ...routingFields
}).superRefine((input, context) => {
  if (input.action === "propose") {
    for (const field of ["type", "title", "rationale", "proposedContent", "sourceFingerprints", "affectedIdentifiers"] as const) {
      if (input[field] === undefined) context.addIssue({ code: "custom", path: [field], message: `propose requires ${field}.` });
    }
  }
  if ((input.action === "approve" || input.action === "reject") && input.id === undefined) {
    context.addIssue({ code: "custom", path: ["id"], message: `${input.action} requires id.` });
  }
});

export const taskReportInputSchema = z.object({
  taskId: taskIdSchema, root: z.string().optional(), disposition: z.enum(["pause", "complete"]).default("complete"),
  responseMode: z.enum(["compact", "verbose"]).optional(), ...routingFields
});

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const taskReadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const CORE_TOOL_METADATA = {
  tokengraph_setup: { title: "Set Up TokenGraph", description: "Check workspace trust and the selected surface.", annotations: readOnlyAnnotations, schema: setupInputSchema },
  tokengraph_prepare_context: { title: "Prepare Task Context", description: "Plan compact context and start a task; verbose adds diagnostics.", annotations: { ...taskReadAnnotations, idempotentHint: false }, schema: prepareContextInputSchema },
  tokengraph_query_context: { title: "Query Task Context", description: "Query graph, SQL, or wiki context; omit taskId to start a task.", annotations: taskReadAnnotations, schema: queryContextInputSchema },
  tokengraph_compress: { title: "Compress Task Material", description: "Compress output or context; omit taskId to start a task.", annotations: taskReadAnnotations, schema: compressInputSchema },
  tokengraph_recall: { title: "Recall Task Knowledge", description: "Recall or review memory; omit taskId to start a task.", annotations: taskReadAnnotations, schema: recallInputSchema },
  tokengraph_analyze: { title: "Analyze Task Evidence", description: "Trace failures, assess risk, or check architecture; omit taskId to start a task.", annotations: taskReadAnnotations, schema: analyzeInputSchema },
  tokengraph_propose_knowledge: { title: "Propose Task Knowledge", description: "Review local knowledge. propose requires type, title, rationale, proposedContent, sourceFingerprints, and affectedIdentifiers; approve/reject require id.", annotations: { ...taskReadAnnotations, idempotentHint: false }, schema: proposeKnowledgeInputSchema },
  tokengraph_task_report: { title: "Set Task Disposition", description: "Complete by default with the canonical footer, or pause; verbose adds the report.", annotations: taskReadAnnotations, schema: taskReportInputSchema }
} as const;

export function coreToolsListDefinitions() {
  return Object.entries(CORE_TOOL_METADATA).map(([name, metadata]) => ({
    name,
    title: metadata.title,
    description: metadata.description,
    annotations: metadata.annotations,
    inputSchema: z.toJSONSchema(metadata.schema, { target: "draft-2020-12", io: "input" })
  }));
}

export function benchmarkMcpInputSchemas(): Record<"planner" | "tracer" | "risk" | "compressor" | "wiki" | "memory", unknown> {
  const inputSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
  return {
    planner: inputSchema(prepareContextInputSchema), tracer: inputSchema(analyzeInputSchema), risk: inputSchema(analyzeInputSchema),
    compressor: inputSchema(compressInputSchema), wiki: inputSchema(queryContextInputSchema), memory: inputSchema(recallInputSchema)
  };
}
