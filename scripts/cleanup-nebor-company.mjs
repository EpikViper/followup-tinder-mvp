import { AttioClient } from "../src/attio.js";

const attio = new AttioClient();
const apply = process.argv.includes("--apply");
const ids = {
  oldCompany: "5a3b0323-9ce6-42bc-bef0-86db7706362b",
  nebor: "72e0ee11-1a63-470a-8dc3-e0d33f94ef90",
  andrew: "5185347d-81ec-4695-94cf-1c6ddff07327",
  oldYannick: "9a480313-228b-4f42-9a2a-5a48f5f09770",
  yannickKok: "b13b5337-c576-4802-98de-93b7e63c5390",
};

async function person(id) {
  const response = await attio.request(`/objects/people/records/${id}`);
  return response?.data || response;
}

const [andrewBefore, yannickBefore, oldNotes] = await Promise.all([person(ids.andrew), person(ids.yannickKok), attio.getNotes(ids.oldCompany)]);
const existingYannickEmails = (yannickBefore.values?.email_addresses || []).map((value) => value.email_address).filter(Boolean);
const report = { mode: apply ? "apply" : "dry-run", oldCompanyNotes: oldNotes.length, moveAndrewTo: ids.nebor, moveYannickEmailTo: ids.yannickKok, deletePerson: ids.oldYannick, deleteCompany: ids.oldCompany, andrewEmails: (andrewBefore.values?.email_addresses || []).map((value) => value.email_address).filter(Boolean), yannickEmails: existingYannickEmails };

if (oldNotes.length) throw new Error("Old company still has notes; aborting deletion");
if (apply) {
  await attio.request(`/objects/people/records/${ids.andrew}`, { method: "PATCH", body: JSON.stringify({ data: { values: { company: [{ target_object: "companies", target_record_id: ids.nebor }] } } }) });
  await attio.request(`/objects/people/records/${ids.oldYannick}`, { method: "PUT", body: JSON.stringify({ data: { values: { email_addresses: [] } } }) });
  await attio.request(`/objects/people/records/${ids.yannickKok}`, { method: "PATCH", body: JSON.stringify({ data: { values: { email_addresses: [...new Set([...existingYannickEmails, "yannick@nebor.io"])] } } }) });

  const [andrewAfter, yannickAfter] = await Promise.all([person(ids.andrew), person(ids.yannickKok)]);
  const andrewCompanies = (andrewAfter.values?.company || []).map((value) => value.target_record_id);
  const yannickEmails = (yannickAfter.values?.email_addresses || []).map((value) => value.email_address?.toLowerCase());
  if (!andrewCompanies.includes(ids.nebor) || !yannickEmails.includes("yannick@nebor.io")) throw new Error("Move verification failed; no records were deleted");

  await attio.request(`/objects/people/records/${ids.oldYannick}`, { method: "DELETE" });
  await attio.request(`/objects/companies/records/${ids.oldCompany}`, { method: "DELETE" });
}

console.log(JSON.stringify(report, null, 2));
