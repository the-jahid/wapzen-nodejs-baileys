// Builds docs/openapi.json from the Go server's OpenAPI document, keeping only
// the chat side of the product.
//
// Usage: node scripts/sync-openapi.mjs <go-openapi.json>
//
// The input is what the Go server serves at /swagger/doc.json (the OpenAPI 3
// document from server/internal/swagger, not the stale swaggo docs/swagger.json).
// Everything is copied as-is except the voice features: voice agents, calls,
// outbound campaigns, ElevenLabs voices, the call-only tool types
// (transfer_call, end_call), and the fields that point at voice agents.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/sync-openapi.mjs <go-openapi.json>');
  process.exit(1);
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'openapi.json');
const doc = JSON.parse(readFileSync(input, 'utf8'));
const schemas = doc.components.schemas;

// apiKeys isn't voice, but this server has no API keys, so it goes too.
const VOICE_TAGS = new Set(['voices', 'Agents', 'Calls', 'Outbound Campaign', 'apiKeys']);
const VOICE_TOOL_TYPES = new Set(['transfer_call', 'end_call']);
const CHAT_TOOL_TYPES = ['api_request', 'send_text'];

doc.info = {
  title: 'WhiskeyBailey API',
  description: 'Backend API for the WhatsApp AI chat agent application.',
  version: doc.info.version,
};
doc.tags = doc.tags.filter((t) => !VOICE_TAGS.has(t.name));
for (const t of doc.tags) {
  if (t.name === 'Tools') {
    t.description = 'Tool CRUD endpoints. Tools are the actions a chat agent can take during a conversation.';
  }
}

for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (op.tags?.some((t) => VOICE_TAGS.has(t))) delete item[method];
  }
  if (Object.keys(item).length === 0) delete doc.paths[path];
}

// Example payloads: drop voice-only tools and the voice-agent link fields.
function scrubExample(v) {
  if (Array.isArray(v)) {
    return v
      .filter((x) => !(x && typeof x === 'object' && VOICE_TOOL_TYPES.has(x.type)))
      .map(scrubExample);
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (['agent_id', 'agent_ids', 'transfer_call', 'end_call'].includes(k)) continue;
      o[k] = scrubExample(x);
    }
    return o;
  }
  if (v === 'type must be one of api_request, transfer_call, end_call, send_text') {
    return 'type must be one of api_request, send_text';
  }
  return v;
}
function scrubExamples(node) {
  if (Array.isArray(node)) return node.forEach(scrubExamples);
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'example') node[k] = scrubExample(v);
    else if (k === 'examples' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [name, ex] of Object.entries(v)) {
        if (VOICE_TOOL_TYPES.has(ex?.value?.type)) delete v[name];
        else if (ex && 'value' in ex) ex.value = scrubExample(ex.value);
      }
    } else scrubExamples(v);
  }
}

// Tools: chat agents only run api_request and send_text.
for (const name of ['Tool', 'CreateToolRequest', 'UpdateToolRequest']) {
  const props = schemas[name].properties;
  delete props.agent_ids;
  delete props.transfer_call;
  delete props.end_call;
  if (props.type) props.type.enum = CHAT_TOOL_TYPES;
  if (schemas[name].required) {
    schemas[name].required = schemas[name].required.filter((r) => !['agent_ids', 'transfer_call', 'end_call'].includes(r));
  }
}
schemas.Tool.description = 'An action a chat agent can take during a conversation.';
schemas.Tool.properties.chat_agent_ids.description =
  "Chat agents this tool is attached to, empty while it is attached to none. Read-only here: attach a tool by writing that chat agent's `tools.tool_ids`. A tool is shared, so the same one can be attached to any number of chat agents; deleting a chat agent detaches it rather than deleting it.";
schemas.CreateToolRequest.description =
  'Request payload for creating a tool. Supply the configuration block matching type: api_request requires its block, while send_text may omit its own.';
const toolsPath = doc.paths['/v1/tools'];
for (const p of toolsPath.get.parameters) {
  if (p.name === 'type') p.schema.enum = CHAT_TOOL_TYPES;
}
toolsPath.post.description =
  "Creates a tool the authenticated user's chat agents can call mid-conversation. The tool is inert until it is attached to a chat agent: creating it only defines the action, it does not offer it in any chat. name and description are what the model reads when deciding whether to call it, so they carry the same weight as prompt text.";
const toolPath = doc.paths['/v1/tools/{tool_id}'];
toolPath.delete.description =
  'Deletes a tool owned by the authenticated user. A tool can be attached to several chat agents, and every one of them simply loses it. Chats already in progress keep the tool for the rest of that conversation.';
toolPath.patch.description =
  'Applies a partial update to a tool; at least one field must be supplied. A configuration block replaces the stored one wholesale. type is fixed at creation. Changes take effect on the next reply: a reply already being written keeps the tool definitions it started with.';
delete schemas.ToolTransferCallConfig;
delete schemas.ToolEndCallConfig;

// Knowledge bases: agent_id names the owning voice agent.
delete schemas.KnowledgeBaseResource.properties.agent_id;

// Phone login: agent_id assigns the number to a voice agent. A chat agent
// takes a number through its own agent.phone_number_id instead.
delete schemas.LoginPhoneNumberRequest.properties.agent_id;
schemas.LoginPhoneNumberRequest.description =
  'Optional metadata for starting a WhatsApp QR login. Pass phone_number_id to restart an existing non-connected login. Set force_repair with phone_number_id to unlink and replace a connected companion while preserving the phone-number row and chat agent assignment.';
doc.paths['/v1/phone-number/login'].post.description =
  'Starts a WhatsApp Linked Devices QR login. With phone_number_id and force_repair, it replaces a connected companion while preserving the phone-number resource and chat agent assignment.';

scrubExamples(doc.paths);
scrubExamples(schemas);

// Drop schemas nothing references any more (repeat: removals cascade).
for (;;) {
  const text = JSON.stringify({ paths: doc.paths, schemas });
  const unused = Object.keys(schemas).filter(
    (n) => !text.includes(`"#/components/schemas/${n}"`),
  );
  // A schema only referenced by itself is still unused.
  const reallyUnused = unused.length
    ? unused
    : Object.keys(schemas).filter((n) => {
        const others = JSON.stringify({ paths: doc.paths, schemas: { ...schemas, [n]: undefined } });
        return !others.includes(`"#/components/schemas/${n}"`);
      });
  if (reallyUnused.length === 0) break;
  for (const n of reallyUnused) delete schemas[n];
}

const json = JSON.stringify(doc, null, 2).replaceAll(
  ' Only api_request and send_text tools apply to a chat; end_call and transfer_call exist to release a phone call and are ignored here.',
  '',
);
writeFileSync(out, json + '\n');
console.log(`wrote ${out}: ${Object.keys(doc.paths).length} paths, ${Object.keys(schemas).length} schemas`);
