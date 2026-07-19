import type { TaskType } from "./types.js";

export function classifyTask(task: string): TaskType {
  const text = task.toLowerCase();
  if (/\b(fix|bug|error|failing|regression)\b/.test(text)) return "bug";
  if (/\b(refactor|cleanup|rename|split)\b/.test(text)) return "refactor";
  if (/\b(sql|database|table|migration|rls|policy|postgres|supabase)\b/.test(text)) return "database";
  if (/\b(test|spec|coverage)\b/.test(text)) return "test";
  if (/\b(doc|readme|guide|documentation)\b/.test(text)) return "docs";
  if (/\b(architecture|design|why|explain)\b/.test(text)) return "architecture";
  return "feature";
}
