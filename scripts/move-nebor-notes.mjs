import { AttioClient } from "../src/attio.js";

const attio = new AttioClient();
const apply = process.argv.includes("--apply");

async function companyForDomain(domain) {
  const response = await attio.request("/objects/companies/records/query", {
    method: "POST",
    body: JSON.stringify({ filter: { domains: { domain: { $eq: domain } } }, limit: 20 }),
  });
  const records = response?.data || [];
  if (records.length !== 1) throw new Error(`Expected one company for ${domain}; found ${records.length}`);
  return records[0];
}

const source = await companyForDomain("nebor.io");
const target = await companyForDomain("nebor.ai");
if (source.id.record_id === target.id.record_id) throw new Error("Source and target are the same company");
const notes = await attio.getNotes(source.id.record_id);
const report = { mode: apply ? "apply" : "dry-run", source: { id: source.id.record_id, name: source.values?.name?.[0]?.value }, target: { id: target.id.record_id, name: target.values?.name?.[0]?.value }, notes: notes.map((note) => ({ id: note.id, title: note.title })) };

if (apply) {
  for (const note of notes) {
    const sourceNoteResponse = await attio.request(`/notes/${encodeURIComponent(note.id)}`);
    const sourceNote = sourceNoteResponse?.data || sourceNoteResponse;
    const content = sourceNote.content_markdown || sourceNote.content_plaintext || note.body;
    const created = await attio.request("/notes", {
      method: "POST",
      body: JSON.stringify({ data: { parent_object: "companies", parent_record_id: target.id.record_id, title: note.title, format: "markdown", content } }),
    });
    if (!(created?.data?.id?.note_id || created?.id?.note_id)) throw new Error(`Replacement note was not created for ${note.id}`);
    await attio.deleteNote(note.id);
  }
}

console.log(JSON.stringify(report, null, 2));
