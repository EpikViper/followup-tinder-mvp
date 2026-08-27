import { AttioClient } from "../src/attio.js";
import { REPS } from "../src/constants.js";

const query = process.argv.slice(2).join(" ").trim().toLowerCase();
if (!query) throw new Error("Provide a contact or company search term");

const attio = new AttioClient();
const companies = (await Promise.all(REPS.map((rep) => attio.getPipelineData(rep.id)))).flat();
const matches = companies.flatMap((company) => company.contacts
  .filter((contact) => `${contact.name} ${company.companyName}`.toLowerCase().includes(query))
  .map((contact) => ({ company, contact })));

const matchingFields = (values) => Object.fromEntries(
  Object.entries(values || {}).filter(([key, value]) =>
    /source|campaign/i.test(key) || /linkedin campaign/i.test(JSON.stringify(value))
  )
);

const result = [];
for (const { company, contact } of matches) {
  const [entry, companyRecord, personResponse] = await Promise.all([
    attio.getEntry(company.entryId),
    attio.getCompany(company.companyId),
    attio.request(`/objects/people/records/${encodeURIComponent(contact.id)}`),
  ]);
  const person = personResponse?.data || personResponse;
  result.push({
    company: company.companyName,
    contact: contact.name,
    mappedSource: contact.source || company.source || null,
    matchingFields: {
      entry: matchingFields(entry?.entry_values || entry?.values),
      company: matchingFields(companyRecord?.values),
      person: matchingFields(person?.values),
    },
  });
}

console.log(JSON.stringify({ found: result.length > 0, matches: result }, null, 2));
