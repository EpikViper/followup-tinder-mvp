import { AttioClient } from "../src/attio.js";
import { REPS } from "../src/constants.js";
import { buildQueue } from "../src/queue.js";

const apply = process.argv.includes("--apply");
const attio = new AttioClient();
const groups = [];

for (const rep of REPS) {
  for (const company of buildQueue(await attio.getPipelineData(rep.id))) {
    const byContent = new Map();
    for (const note of await attio.getNotes(company.companyId)) {
      const key = `${note.title.trim().toLowerCase()}\0${note.body.trim().replace(/\s+/g, " ").toLowerCase()}`;
      byContent.set(key, [...(byContent.get(key) || []), note]);
    }
    for (const notes of byContent.values()) if (notes.length > 1) {
      const ordered = [...notes].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      groups.push({ company: company.companyName, keep: ordered[0].id, delete: ordered.slice(1).map((note) => note.id), title: ordered[0].title });
    }
  }
}

if (apply) for (const group of groups) for (const noteId of group.delete) await attio.deleteNote(noteId);
console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", groups, deleted: apply ? groups.reduce((count, group) => count + group.delete.length, 0) : 0 }, null, 2));
