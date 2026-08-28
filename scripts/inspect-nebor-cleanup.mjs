import { AttioClient } from "../src/attio.js";

const attio = new AttioClient();
const sourceCompanyId = "5a3b0323-9ce6-42bc-bef0-86db7706362b";

async function queryPeople(filter) {
  const response = await attio.request("/objects/people/records/query", {
    method: "POST",
    body: JSON.stringify({ filter, limit: 50 }),
  });
  return response?.data || [];
}

function person(record) {
  const values = record.values || {};
  return {
    id: record.id?.record_id,
    name: values.name?.[0]?.full_name || values.name?.[0]?.value || "",
    emails: (values.email_addresses || []).map((value) => value.email_address).filter(Boolean),
    companies: (values.company || []).map((value) => value.target_record_id).filter(Boolean),
    linkedin: values.linkedin?.[0]?.value || null,
  };
}

const [sourcePeople, yannicks, sourceNotes] = await Promise.all([
  queryPeople({ company: { target_object: "companies", target_record_id: sourceCompanyId } }),
  queryPeople({ name: { full_name: { $eq: "Yannick Kok" } } }),
  attio.getNotes(sourceCompanyId),
]);
console.log(JSON.stringify({ sourceCompanyId, sourceNotes: sourceNotes.map((note) => ({ id: note.id, title: note.title })), sourcePeople: sourcePeople.map(person), yannickCandidates: yannicks.map(person) }, null, 2));
