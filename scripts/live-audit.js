import { AttioClient } from "../src/attio.js";
import { LINKEDIN_SENDERS, REPS } from "../src/constants.js";
import { buildQueue } from "../src/queue.js";
import { UnipileClient } from "../src/unipile.js";

const attio = new AttioClient();
const unipile = new UnipileClient();
const owners = [];

for (const rep of REPS) {
  const companies = await attio.getPipelineData(rep.id);
  const queue = buildQueue(companies);
  const byType = Object.fromEntries(
    ["unprocessed", "inbound", "no_show", "follow_up"].map((type) => [
      type,
      queue.filter((company) => company.queueType === type).length,
    ])
  );
  owners.push({
    rep: rep.name,
    pipelineCompanies: companies.length,
    eligible: queue.length,
    byType,
    unprocessedReadyToPromote: companies.filter((company) => company.stage === "Unprocessed" && company.lastInteractionBy === "Us").length,
    missingContacts: queue.filter((company) => company.contacts.length === 0).length,
    missingLinkedin: queue.filter((company) => !company.contacts[0]?.linkedinUrl).length,
    missingEmail: queue.filter((company) => !company.contacts.some((contact) => contact.emails.length)).length,
  });
}

const connected = await unipile.listAllowedAccounts();
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  owners,
  linkedinSenders: LINKEDIN_SENDERS.map((sender) => ({
    name: sender.name,
    connected: connected.find((account) => account.id === sender.id)?.connected === true,
  })),
}, null, 2));
