import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const apiKey = process.env.N8N_API_KEY;
if (!apiKey) throw new Error("N8N_API_KEY is unavailable");

const baseUrl = "https://velogtm.co/api/v1";
const outputDir = path.resolve("docs/integration/backups/2026-08-27-before-remediation");
const workflows = [
  ["d6FagRZslhkj5Zyk", "linkedin-unipile-webhook"],
  ["gw3u2a4xBbHltwZJ", "linkedin-nightly-reconciler"],
  ["o6HZL39NOaOASH2D", "linkedin-unmatched-create"],
];

await mkdir(outputDir, { recursive: true });

for (const [id, slug] of workflows) {
  const response = await fetch(`${baseUrl}/workflows/${id}`, {
    headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Could not export workflow ${id}: HTTP ${response.status}`);
  }

  const workflow = await response.json();
  const file = path.join(outputDir, `${slug}_${id}.json`);
  await writeFile(file, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  console.log(`${workflow.name} -> ${path.relative(process.cwd(), file)}`);
}
