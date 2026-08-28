import { readFile } from "node:fs/promises";
import process from "node:process";

const apiKey = process.env.N8N_API_KEY;
if (!apiKey) throw new Error("N8N_API_KEY is unavailable");
const api = "https://velogtm.co/api/v1";
const headers = { "X-N8N-API-KEY": apiKey, Accept: "application/json" };
const manifest = JSON.parse(await readFile("docs/integration/linkedin-attio-workflows.json", "utf8"));
const tables = JSON.parse(await readFile("docs/integration/linkedin-attio-data-tables.json", "utf8"));
const backupDir = "docs/integration/backups/2026-08-27-before-remediation";
const liveBackup = JSON.parse(await readFile(`${backupDir}/linkedin-unipile-webhook_d6FagRZslhkj5Zyk.json`, "utf8"));
const nightlyBackup = JSON.parse(await readFile(`${backupDir}/linkedin-nightly-reconciler_gw3u2a4xBbHltwZJ.json`, "utf8"));
const actionBackup = JSON.parse(await readFile(`${backupDir}/linkedin-unmatched-create_o6HZL39NOaOASH2D.json`, "utf8"));

const get = async (pathname) => {
  const response = await fetch(`${api}${pathname}`, { headers });
  if (!response.ok) throw new Error(`GET ${pathname}: HTTP ${response.status}`);
  return await response.json();
};
const exactTrigger = (workflow, type) => workflow.nodes.filter((node) => node.type === type).map((node) => ({
  name: node.name, parameters: node.parameters, webhookId: node.webhookId,
}));
const same = (left, right, label) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${label} changed`);
};

const live = await get("/workflows/d6FagRZslhkj5Zyk");
const nightly = await get("/workflows/gw3u2a4xBbHltwZJ");
const action = await get("/workflows/o6HZL39NOaOASH2D");
const shared = await Promise.all([
  manifest.sharedResolverId, manifest.sharedMutationId, manifest.sharedProcessorId,
].map((id) => get(`/workflows/${id}`)));

for (const workflow of [live, nightly, action, ...shared]) {
  if (!workflow.active) throw new Error(`${workflow.name} is not active`);
  if (JSON.stringify(workflow.nodes).includes("$getWorkflowStaticData")) throw new Error(`${workflow.name} still uses static workflow data`);
}
same(exactTrigger(live, "n8n-nodes-base.webhook"), exactTrigger(liveBackup, "n8n-nodes-base.webhook"), "Live webhook");
same(exactTrigger(action, "n8n-nodes-base.webhook"), exactTrigger(actionBackup, "n8n-nodes-base.webhook"), "Action webhook");
same(exactTrigger(nightly, "n8n-nodes-base.scheduleTrigger"), exactTrigger(nightlyBackup, "n8n-nodes-base.scheduleTrigger"), "Reconciler schedules");

const remoteTables = await get("/data-tables?limit=100");
for (const [name, expected] of Object.entries(tables)) {
  const table = remoteTables.data.find((candidate) => candidate.id === expected.id && candidate.name === name);
  if (!table) throw new Error(`Missing data table ${name}`);
  const actualColumns = new Map(table.columns.map((column) => [column.name, column.type]));
  for (const column of expected.columns) {
    if (actualColumns.get(column.name) !== column.type) throw new Error(`${name}.${column.name} is missing or has the wrong type`);
  }
}

console.log("active workflows: 6/6");
console.log("webhook paths and IDs: preserved");
console.log("reconciler schedules: preserved");
console.log("data table schemas: verified");
console.log("workflow static-data dedupe: absent");
