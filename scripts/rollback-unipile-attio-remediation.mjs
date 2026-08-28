import { readFile } from "node:fs/promises";
import process from "node:process";

const apiKey = process.env.N8N_API_KEY;
if (!apiKey) throw new Error("N8N_API_KEY is unavailable");
const api = "https://velogtm.co/api/v1";
const backupDir = "docs/integration/backups/2026-08-27-before-remediation";
const backups = [
  ["d6FagRZslhkj5Zyk", "linkedin-unipile-webhook_d6FagRZslhkj5Zyk.json"],
  ["gw3u2a4xBbHltwZJ", "linkedin-nightly-reconciler_gw3u2a4xBbHltwZJ.json"],
  ["o6HZL39NOaOASH2D", "linkedin-unmatched-create_o6HZL39NOaOASH2D.json"],
];
const allowedSettings = new Set([
  "executionOrder", "errorWorkflow", "saveDataSuccessExecution", "saveDataErrorExecution",
  "timezone", "executionTimeout", "callerPolicy", "saveExecutionProgress",
]);

for (const [id, file] of backups) {
  const backup = JSON.parse(await readFile(`${backupDir}/${file}`, "utf8"));
  const definition = {
    name: backup.name,
    nodes: backup.nodes,
    connections: backup.connections,
    settings: Object.fromEntries(Object.entries(backup.settings || {}).filter(([key]) => allowedSettings.has(key))),
  };
  const response = await fetch(`${api}/workflows/${id}`, {
    method: "PUT",
    headers: { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(definition),
  });
  if (!response.ok) throw new Error(`Rollback failed for ${id}: HTTP ${response.status}`);
  const restored = await response.json();
  console.log(`Restored ${restored.name} [${id}]`);
}
