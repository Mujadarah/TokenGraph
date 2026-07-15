import { createHash } from "node:crypto";

import { filterUntrustedSourceText } from "./storagePolicy.js";

export interface VaultMemory {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  links?: string[];
  supersedes?: string;
  archived?: boolean;
  updatedAt: string;
}

export interface VaultNote {
  path: string;
  title: string;
  body: string;
  hash: string;
  backlinks: string[];
  archived: boolean;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _-]+/g, "-").trim().replace(/\s+/g, "-").toLowerCase() || "untitled";
}

export function projectToVault(memories: VaultMemory[], options: { folder?: string; maxBytes?: number } = {}): VaultNote[] {
  const folder = options.folder ?? "tokengraph";
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const superseded = new Set(memories.map((memory) => memory.supersedes).filter((id): id is string => Boolean(id)));
  const notes: VaultNote[] = [];
  for (const memory of [...memories].sort((a, b) => a.id.localeCompare(b.id))) {
    const body = filterUntrustedSourceText(memory.body).trim();
    const backlinks = [...new Set((memory.links ?? []).filter((id) => byId.has(id)))].sort();
    const links = backlinks.map((id) => `[[${safeName(byId.get(id)!.title)}]]`).join(" ");
    const content = `---\nid: ${memory.id}\ntitle: ${memory.title.replace(/[\r\n]/g, " ")}\nupdated: ${memory.updatedAt}\narchived: ${Boolean(memory.archived || superseded.has(memory.id))}\n---\n\n${body}${links ? `\n\n${links}` : ""}\n`;
    notes.push({ path: `${folder}/${safeName(memory.title)}-${memory.id}.md`, title: memory.title, body: content, hash: createHash("sha256").update(content).digest("hex"), backlinks, archived: Boolean(memory.archived || superseded.has(memory.id)) });
  }
  return compactVaultNotes(notes, options.maxBytes ?? Number.MAX_SAFE_INTEGER);
}

export function compactVaultNotes(notes: VaultNote[], maxBytes: number): VaultNote[] {
  const output: VaultNote[] = [];
  let used = 0;
  for (const note of [...notes].sort((a, b) => Number(a.archived) - Number(b.archived) || a.path.localeCompare(b.path))) {
    const bytes = Buffer.byteLength(note.body, "utf8");
    if (used + bytes > maxBytes) continue;
    output.push(note);
    used += bytes;
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
