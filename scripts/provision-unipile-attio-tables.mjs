import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const apiKey = process.env.N8N_API_KEY;
if (!apiKey) throw new Error("N8N_API_KEY is unavailable");

const apiUrl = "https://velogtm.co/api/v1";
const projectId = "Kpi0jPRG9V8d3lxr";
const schemas = [
  {
    name: "linkedin_attio_event_ledger",
    columns: [
      ["event_key", "string"], ["account_id", "string"], ["chat_id", "string"],
      ["message_id", "string"], ["event_timestamp", "date"], ["direction", "string"],
      ["status", "string"], ["attempts", "number"], ["completed_steps", "string"],
      ["outputs", "string"], ["last_error", "string"], ["normalized_event", "string"],
      ["case_key", "string"], ["person_id", "string"], ["company_id", "string"],
      ["started_at", "date"], ["updated_at", "date"], ["next_retry_at", "date"],
      ["stale_after", "date"], ["cleanup_note_id", "string"],
    ],
  },
  {
    name: "linkedin_attio_case_ledger",
    columns: [
      ["case_key", "string"], ["account_id", "string"], ["chat_id", "string"],
      ["reason", "string"], ["status", "string"], ["person_id", "string"],
      ["candidate_ids", "string"], ["company_id", "string"], ["slack_channel", "string"],
      ["slack_ts", "string"], ["message_count", "number"], ["latest_preview", "string"],
      ["event_keys", "string"], ["resolution", "string"], ["resolved_at", "date"],
      ["updated_at", "date"], ["action_nonce", "string"], ["action_result", "string"],
      ["company_name", "string"], ["company_domain", "string"], ["company_evidence", "string"],
    ],
  },
  {
    name: "linkedin_attio_chat_state",
    columns: [
      ["sync_key", "string"], ["account_id", "string"], ["chat_id", "string"],
      ["company_id", "string"], ["person_id", "string"], ["newest_committed_at", "date"],
      ["newest_message_id", "string"], ["last_direction", "string"], ["note_id", "string"],
      ["cleanup_note_id", "string"], ["history_cursor", "string"], ["history_truncated", "boolean"],
      ["lock_until", "date"], ["lock_owner", "string"], ["updated_at", "date"],
    ],
  },
].map((table) => ({
  ...table,
  columns: table.columns.map(([name, type]) => ({ name, type })),
}));

const request = async (pathname, options = {}) => {
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...options,
    headers: {
      "X-N8N-API-KEY": apiKey,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname}: HTTP ${response.status}`);
  return await response.json();
};

const existing = await request("/data-tables?limit=100");
const manifest = {};

for (const schema of schemas) {
  let table = existing.data.find((candidate) => candidate.name === schema.name);
  if (!table) {
    table = await request("/data-tables", {
      method: "POST",
      body: JSON.stringify({ ...schema, projectId }),
    });
    console.log(`Created ${schema.name}`);
  } else {
    const actual = new Map((table.columns || []).map((column) => [column.name, column.type]));
    const mismatch = schema.columns.find((column) => actual.has(column.name) && actual.get(column.name) !== column.type);
    if (mismatch) {
      throw new Error(`${schema.name}.${mismatch.name} has an unexpected type; refusing to modify it`);
    }
    for (const column of schema.columns.filter((candidate) => !actual.has(candidate.name))) {
      await request(`/data-tables/${table.id}/columns`, { method: "POST", body: JSON.stringify(column) });
      console.log(`Added ${schema.name}.${column.name}`);
    }
    console.log(`Reused ${schema.name}`);
  }
  manifest[schema.name] = { id: table.id, projectId: table.projectId, columns: schema.columns };
}

const output = path.resolve("docs/integration/linkedin-attio-data-tables.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Manifest -> ${path.relative(process.cwd(), output)}`);
