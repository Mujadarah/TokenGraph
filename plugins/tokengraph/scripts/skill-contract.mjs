export const CORE_TOOL_NAMES = [
  "tokengraph_setup",
  "tokengraph_prepare_context",
  "tokengraph_query_context",
  "tokengraph_compress",
  "tokengraph_recall",
  "tokengraph_analyze",
  "tokengraph_propose_knowledge",
  "tokengraph_task_report"
];

export const LEGACY_TOOL_NAMES = [
  "tokengraph_add_rule", "tokengraph_assess_change_risk", "tokengraph_check_architecture", "tokengraph_compress_context",
  "tokengraph_compress_output", "tokengraph_confirm_memory", "tokengraph_delete_memory", "tokengraph_delete_rule",
  "tokengraph_deprecate_memory", "tokengraph_explain_symbol", "tokengraph_export_project_map", "tokengraph_find_memory_conflicts",
  "tokengraph_generate_wiki", "tokengraph_get_config", "tokengraph_index_project", "tokengraph_index_status",
  "tokengraph_link_memory", "tokengraph_list_rules", "tokengraph_plan_context", "tokengraph_project_map",
  "tokengraph_recall_memory", "tokengraph_remember_decision", "tokengraph_reset_project", "tokengraph_review_memories",
  "tokengraph_search_graph", "tokengraph_set_profile", "tokengraph_setup_status", "tokengraph_show_token_savings",
  "tokengraph_show_wiki_page", "tokengraph_summarize_sql", "tokengraph_trace_failure", "tokengraph_update_config",
  "tokengraph_update_memory", "tokengraph_update_rule"
];

const coreTools = new Set(CORE_TOOL_NAMES);
const legacyTools = new Set(LEGACY_TOOL_NAMES);

// Transitional compatibility only: Phase 5 will remove legacy skill-contract acceptance after the committed release is regenerated.
export function classifySkillContract(skills) {
  const references = [...new Set(skills.flatMap((skill) => [...skill.matchAll(/\btokengraph_[a-z0-9_]+\b/g)].map((match) => match[0])))].sort();
  const hasCoreReference = references.some((name) => coreTools.has(name));
  if (hasCoreReference) {
    return {
      contract: "core",
      forbiddenCoreTools: references.filter((name) => !coreTools.has(name))
    };
  }
  if (references.length > 0 && references.every((name) => legacyTools.has(name))) {
    return { contract: "legacy", forbiddenCoreTools: [] };
  }
  throw new Error("Skill set is neither core nor wholly legacy.");
}
