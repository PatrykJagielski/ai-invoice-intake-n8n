// Sprawdza parametry węzłów workflowów walidatorem n8n (NodeHelpers.getNodeParametersIssues).
// Uruchamiane wewnątrz kontenera n8n:
//   docker exec n8n node /import/tests/check_node_params.cjs /import/workflows
const fs = require('fs');
const path = require('path');
const ROOT = '/usr/local/lib/node_modules/n8n/node_modules';
const { NodeHelpers } = require(path.join(ROOT, 'n8n-workflow'));
const pnpm = path.join(ROOT, '.pnpm');
const base = fs.readdirSync(pnpm).find((d) => d.startsWith('n8n-nodes-base@file'));
const descriptions = JSON.parse(fs.readFileSync(path.join(pnpm, base, 'node_modules/n8n-nodes-base/dist/types/nodes.json'), 'utf8'));

function findDescription(type, version) {
  const name = type.replace('n8n-nodes-base.', '');
  return descriptions.find((d) => d.name === `n8n-nodes-base.${name}` || d.name === name
    ? (Array.isArray(d.version) ? d.version.includes(version) : d.version === version)
    : false);
}

const dir = process.argv[2];
let problems = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
  const wf = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  for (const node of wf.nodes) {
    const desc = findDescription(node.type, node.typeVersion);
    if (!desc) {
      console.log(`${file} | ${node.name}: BRAK OPISU dla ${node.type} v${node.typeVersion}`);
      problems++;
      continue;
    }
    const full = NodeHelpers.getNodeParameters(desc.properties, node.parameters, true, false, node, desc);
    const issues = NodeHelpers.getNodeParametersIssues(desc.properties, { ...node, parameters: full }, desc);
    // Nieznane parametry (literówki w nazwach pól)
    const known = new Set(desc.properties.map((p) => p.name));
    const unknown = Object.keys(node.parameters).filter((k) => !known.has(k));
    if (issues || unknown.length) {
      problems++;
      console.log(`${file} | ${node.name} (${node.type} v${node.typeVersion}):`, JSON.stringify(issues && issues.parameters), unknown.length ? 'nieznane: ' + unknown.join(',') : '');
    }
  }
}
console.log(problems ? `Problemy: ${problems}` : 'OK — brak problemów z parametrami');
process.exit(problems ? 1 : 0);
