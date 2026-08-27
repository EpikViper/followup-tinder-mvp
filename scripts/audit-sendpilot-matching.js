import { AttioClient } from "../src/attio.js";
import { REPS } from "../src/constants.js";
import { buildQueue } from "../src/queue.js";
import { addUnipileFallbacks } from "../src/linkedin-routing.js";
import { SendPilotClient } from "../src/sendpilot.js";
import { UnipileClient } from "../src/unipile.js";

const attio = new AttioClient();
const sendpilot = new SendPilotClient();
const unipile = new UnipileClient();
const rows = [];

for (const rep of REPS) {
  const queue = buildQueue(await attio.getPipelineData(rep.id));
  for (const company of queue) {
    for (const contact of company.contacts || []) {
      rows.push({ rep: rep.name, company: company.companyName, contact });
    }
  }
}

const people = rows.map((row) => row.contact);
const sendpilotRoutes = await sendpilot.syncRoutingsForPeople(people);
const routes = await addUnipileFallbacks(people, sendpilotRoutes, unipile);
const report = {
  contacts: rows.length,
  conversationsFound: 0,
  sendableContacts: 0,
  outcomes: {},
  matchStrategies: {},
  sendProviders: {},
};

const increment = (collection, key, example) => {
  const item = collection[key] ||= { count: 0, examples: [] };
  item.count += 1;
  if (example && item.examples.length < 5) item.examples.push(example);
};

rows.forEach((row, index) => {
  const route = routes[index];
  const choices = route.routes?.length ? route.routes : route.conversationId ? [route] : [];
  const sendable = choices.some((choice) => choice.verified);
  const providerExample = `${row.contact.name} - ${row.company}`;
  if (choices.length) report.conversationsFound += 1;
  if (sendable) report.sendableContacts += 1;
  for (const provider of new Set(choices.filter((choice) => choice.verified).map((choice) =>
    choice.source === "unipile_fallback" ? "unipile_fallback" : "sendpilot"
  ))) increment(report.sendProviders, provider, providerExample);

  const outcome = route.routes?.length
    ? `multiple conversations (${route.routes.filter((choice) => choice.verified).length} sendable / ${route.routes.length})`
    : route.verified
      ? route.source === "unipile_fallback" ? "verified via Unipile fallback" : "verified via SendPilot"
      : route.reason || "unverified";
  const example = `${row.contact.name} · ${row.company}`;
  increment(report.outcomes, outcome, example);

  const strategies = new Set(choices.map((choice) => choice.match?.strategy).filter(Boolean));
  if (!strategies.size) increment(report.matchStrategies, "none", example);
  for (const strategy of strategies) increment(report.matchStrategies, strategy, example);
});

console.log(JSON.stringify(report, null, 2));
