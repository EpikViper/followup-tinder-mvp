import { AttioClient } from "../src/attio.js";
import { REPS } from "../src/constants.js";
import { SendPilotClient } from "../src/sendpilot.js";

const query = process.argv.slice(2).join(" ").trim().toLowerCase();
if (!query) throw new Error("Provide a contact or company search term");

const attio = new AttioClient();
const sendpilot = new SendPilotClient();
const sourceFields = (values) => Object.fromEntries(
  Object.entries(values || {})
    .filter(([key]) => /source|campaign|lead/i.test(key))
    .map(([key, value]) => [key, value])
);
const companies = (await Promise.all(REPS.map((rep) => attio.getPipelineData(rep.id)))).flat();
const matches = companies.flatMap((company) => company.contacts
  .filter((contact) => `${contact.name} ${company.companyName}`.toLowerCase().includes(query))
  .map((contact) => ({ company, contact })));

if (!matches.length) {
  console.log(JSON.stringify({ found: false, query }, null, 2));
  process.exit(0);
}

const result = [];
for (const { company, contact } of matches) {
  const route = await sendpilot.getRoutingForPerson(contact);
  const leadIndex = await sendpilot.getLeadIndex();
  const entry = await attio.getEntry(company.entryId);
  const companyRecord = await attio.getCompany(company.companyId);
  const personRecord = await attio.request(`/objects/people/records/${encodeURIComponent(contact.id)}`);
  const matchingLeads = [...leadIndex.byUrl.values()].flat().filter((lead) =>
    String(lead.linkedinUrl || "").toLowerCase().includes(query.replace(/\s+/g, "-")) ||
    `${lead.firstName || ""} ${lead.lastName || ""} ${lead.company || ""}`.toLowerCase().includes(query)
  ).map((lead) => ({ id: lead.id, linkedinUrl: lead.linkedinUrl, company: lead.company, status: lead.status, campaignName: lead.campaignName, campaignStatus: lead.campaignStatus }));
  const senders = await sendpilot.listAllowedSenders();
  const inboxMatches = (await Promise.all(senders.map(async (sender) => {
    const conversations = await sendpilot.listSenderConversations(sender.id);
    return conversations.flatMap((conversation) => (conversation.participants || [])
      .filter((participant) => `${participant.name || ""} ${participant.profileUrl || ""}`.toLowerCase().includes(query))
      .map((participant) => ({ sender: sender.name, participant: participant.name, profileUrl: participant.profileUrl, conversationId: conversation.id, lastActivityAt: conversation.lastActivityAt })));
  }))).flat();
  const { messages, ...safeRoute } = route;
  result.push({
    company: company.companyName,
    stage: company.stage,
    sourceAttributes: {
      entry: sourceFields(entry?.entry_values || entry?.values),
      company: sourceFields(companyRecord?.values),
      person: sourceFields(personRecord?.data?.values || personRecord?.values),
    },
    contact: contact.name,
    linkedinUrl: contact.linkedinUrl,
    routing: safeRoute,
    matchingLeads,
    inboxMatches,
    messageCount: messages?.length || 0,
  });
}
console.log(JSON.stringify({ found: true, matches: result }, null, 2));
