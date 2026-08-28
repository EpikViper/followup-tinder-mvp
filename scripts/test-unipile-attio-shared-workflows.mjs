import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const apiKey = process.env.N8N_API_KEY;
if (!apiKey) throw new Error("N8N_API_KEY is unavailable");
const api = "https://velogtm.co/api/v1";
const webhook = "https://velogtm.co/webhook/linkedin-attio-remediation-harness";
const manifestFile = "docs/integration/linkedin-attio-workflows.json";
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));

const headers = { "X-N8N-API-KEY": apiKey, Accept: "application/json", "Content-Type": "application/json" };
const request = async (pathname, options = {}) => {
  const response = await fetch(`${api}${pathname}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname}: HTTP ${response.status}`);
  return body;
};

const workflow = {
  name: "TEMP — LinkedIn Attio remediation harness",
  nodes: [
    {
      id: "harness-webhook", name: "Run fixture", type: "n8n-nodes-base.webhook", typeVersion: 2,
      position: [0, 0], webhookId: "8f30a47a-f5dd-438b-99a7-111232927827",
      parameters: { httpMethod: "POST", path: "linkedin-attio-remediation-harness", responseMode: "lastNode", options: {} },
    },
    {
      id: "which-test", name: "Which fixture", type: "n8n-nodes-base.switch", typeVersion: 3, position: [220, 0],
      parameters: {
        rules: { values: ["resolver", "mutation", "processor"].map((value) => ({
          conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 }, conditions: [{ id: value, leftValue: "={{ $json.body.test }}", rightValue: value, operator: { type: "string", operation: "equals" } }], combinator: "and" },
          renameOutput: true, outputKey: value,
        })) },
        options: { fallbackOutput: "extra" },
      },
    },
    {
      id: "unwrap-resolver", name: "Resolver fixture", type: "n8n-nodes-base.code", typeVersion: 2, position: [440, -120],
      parameters: { jsCode: "return [{json:$json.body.input}];" },
    },
    {
      id: "call-resolver", name: "Call inactive resolver", type: "n8n-nodes-base.executeWorkflow", typeVersion: 1.2, position: [660, -120],
      parameters: { workflowId: { __rl: true, mode: "id", value: manifest.sharedResolverId }, mode: "each", workflowInputs: { mappingMode: "defineBelow", value: {} }, options: { waitForSubWorkflow: true } },
    },
    {
      id: "unwrap-mutation", name: "Mutation fixture", type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 120],
      parameters: { jsCode: "return [{json:$json.body.input}];" },
    },
    {
      id: "call-mutation", name: "Call inactive mutation", type: "n8n-nodes-base.executeWorkflow", typeVersion: 1.2, position: [660, 120],
      parameters: { workflowId: { __rl: true, mode: "id", value: manifest.sharedMutationId }, mode: "each", workflowInputs: { mappingMode: "defineBelow", value: {} }, options: { waitForSubWorkflow: true } },
    },
    {
      id: "unwrap-processor", name: "Processor fixture", type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 300],
      parameters: { jsCode: "return [{json:$json.body.input}];" },
    },
    {
      id: "call-processor", name: "Call inactive processor", type: "n8n-nodes-base.executeWorkflow", typeVersion: 1.2, position: [660, 300],
      parameters: { workflowId: { __rl: true, mode: "id", value: manifest.sharedProcessorId }, mode: "each", workflowInputs: { mappingMode: "defineBelow", value: {} }, options: { waitForSubWorkflow: true } },
    },
    {
      id: "unsupported", name: "Unsupported fixture", type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 480],
      parameters: { jsCode: "return [{json:{ok:false,error:'unsupported fixture'}}];" },
    },
  ],
  connections: {
    "Run fixture": { main: [[{ node: "Which fixture", type: "main", index: 0 }]] },
    "Which fixture": { main: [
      [{ node: "Resolver fixture", type: "main", index: 0 }],
      [{ node: "Mutation fixture", type: "main", index: 0 }],
      [{ node: "Processor fixture", type: "main", index: 0 }],
      [{ node: "Unsupported fixture", type: "main", index: 0 }],
    ] },
    "Resolver fixture": { main: [[{ node: "Call inactive resolver", type: "main", index: 0 }]] },
    "Mutation fixture": { main: [[{ node: "Call inactive mutation", type: "main", index: 0 }]] },
    "Processor fixture": { main: [[{ node: "Call inactive processor", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", saveDataSuccessExecution: "all", saveDataErrorExecution: "all" },
};

let harness;
if (manifest.testHarnessId) {
  harness = await request(`/workflows/${manifest.testHarnessId}`, { method: "PUT", body: JSON.stringify(workflow) });
} else {
  harness = await request("/workflows", { method: "POST", body: JSON.stringify(workflow) });
  manifest.testHarnessId = harness.id;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

// n8n requires referenced subworkflows to be published before a harness can call
// them. Preserve their initial active state so this script is safe both before and
// after production rollout.
const sharedIds = [manifest.sharedResolverId, manifest.sharedMutationId, manifest.sharedProcessorId];
const initialActive = new Map();
for (const id of sharedIds) {
  const current = await request(`/workflows/${id}`);
  initialActive.set(id, Boolean(current.active));
  if (!current.active) await request(`/workflows/${id}/activate`, { method: "POST", body: "{}" });
}
await request(`/workflows/${harness.id}/activate`, { method: "POST", body: "{}" });
try {
  const event = {
    eventKey: "fixture-account:fixture-message", accountId: "fixture-account", chatId: "fixture-chat", messageId: "fixture-message",
    timestamp: "2026-08-27T08:00:00.000Z", direction: "inbound", text: "Sanitized fixture", repName: "Fixture Rep",
    counterpart: { urn: "fixture-urn-no-production-match", profileUrl: "https://www.linkedin.com/in/fixture-no-production-match", name: "Fixture No Production Match", originalName: "Fixture No Production Match", normalizedName: "fixture no production match", occupation: "Fixture role" },
  };
  const resolverResponse = await fetch(webhook, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test: "resolver", input: { event } }),
  });
  const resolverResult = await resolverResponse.json();
  if (!resolverResponse.ok || resolverResult.resolution?.status !== "unmatched") {
    throw new Error(`Resolver fixture failed: ${resolverResponse.status}`);
  }
  console.log("resolver fixture: unmatched as expected");

  const mutationResponse = await fetch(webhook, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ test: "mutation", input: { dryRun: true, mode: "sync", event, resolution: {} } }),
  });
  const mutationResult = await mutationResponse.json();
  if (!mutationResponse.ok || mutationResult.ok !== true || mutationResult.dryRun !== true) {
    throw new Error(`Mutation dry-run fixture failed: ${mutationResponse.status}`);
  }
  console.log("mutation fixture: dry-run plan accepted");

  const processorResponse = await fetch(webhook, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ test: "processor", input: { proceed: false, skipReason: "sanitized processor fixture" } }),
  });
  const processorResult = await processorResponse.json();
  if (!processorResponse.ok || processorResult.status !== "ignored") {
    throw new Error(`Processor fixture failed: ${processorResponse.status}`);
  }
  console.log("processor fixture: ignored envelope returned without side effects");
} finally {
  await request(`/workflows/${harness.id}/deactivate`, { method: "POST", body: "{}" });
  for (const id of [...sharedIds].reverse()) {
    if (!initialActive.get(id)) await request(`/workflows/${id}/deactivate`, { method: "POST", body: "{}" });
  }
}
