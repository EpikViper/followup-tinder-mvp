import { AttioClient } from "../src/attio.js";
import { REPS } from "../src/constants.js";
import { buildQueue } from "../src/queue.js";
import { SendPilotClient } from "../src/sendpilot.js";

const attio = new AttioClient();
const sendpilot = new SendPilotClient();
const report = {};

for (const rep of REPS) {
  const queue = buildQueue(await attio.getPipelineData(rep.id));
  const contacts = queue.flatMap((company) => company.contacts);
  const routes = await Promise.all(contacts.map((contact) => sendpilot.getRoutingForPerson(contact)));
  report[rep.name] = {
    queueCompanies: queue.length,
    contacts: contacts.length,
    sendpilotVerified: routes.filter((route) => route.source === "sendpilot_campaign" && route.verified).length,
    sendpilotManual: routes.filter((route) => route.source === "sendpilot_campaign" && !route.verified).length,
    manual: routes.filter((route) => route.source === "manual").length,
  };
}

console.log(JSON.stringify(report, null, 2));
