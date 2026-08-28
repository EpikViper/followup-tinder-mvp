import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("docs/integration/generated");
const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
if (!files.length) throw new Error("No generated workflow definitions found");

for (const file of files) {
  const workflow = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const names = workflow.nodes.map((node) => node.name);
  const known = new Set(names);
  if (known.size !== names.length) throw new Error(`${file}: duplicate node names`);

  for (const node of workflow.nodes) {
    if (node.type === "n8n-nodes-base.code") {
      try {
        Function(`return async function n8nCodeNode() {\n${node.parameters.jsCode}\n}`)();
      } catch (error) {
        throw new Error(`${file} / ${node.name}: ${error.message}`);
      }
    }
    const serialized = JSON.stringify(node);
    if (/sk-[a-z0-9]{12,}/i.test(serialized)) throw new Error(`${file}: possible API secret in ${node.name}`);
  }

  for (const [source, outputs] of Object.entries(workflow.connections)) {
    if (!known.has(source)) throw new Error(`${file}: unknown connection source ${source}`);
    for (const branch of outputs.main || []) {
      for (const target of branch || []) {
        if (!known.has(target.node)) throw new Error(`${file}: unknown connection target ${target.node}`);
      }
    }
  }
  console.log(`${file}: ${workflow.nodes.length} nodes valid`);
}
