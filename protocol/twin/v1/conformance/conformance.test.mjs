// Validates every fixture under conformance/ against the twin/v1 schemas.
//
//   valid/messages/*.json    MUST pass message.schema.json and be at most 65536 bytes
//   valid/manifest/*.json    MUST pass manifest.schema.json
//   invalid/messages/*.json  MUST fail message.schema.json
//   invalid/manifest/*.json  MUST fail manifest.schema.json
//
// Each valid message fixture is named <type>[.<variant>].json, and every message
// type that message.schema.json knows has at least one valid fixture.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const MAX_FRAME_BYTES = 65536;
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'schema');

const ajv = loadSchemas();
const validateMessage = ajv.getSchema('https://ratel.sh/protocol/twin/v1/message.schema.json');
const validateManifest = ajv.getSchema('https://ratel.sh/protocol/twin/v1/manifest.schema.json');
const knownTypes = readJson(join(SCHEMA_DIR, 'message.schema.json')).properties.type.enum;

describe('valid message fixtures', () => {
  for (const [name, frame, raw] of fixtures('valid/messages')) {
    it(`${name} passes message.schema.json`, () => {
      assert.ok(validateMessage(frame), explain(validateMessage));
      assert.equal(name.split('.json')[0].startsWith(frame.type), true, `${name} is not named after its type`);
      assert.ok(Buffer.byteLength(raw) <= MAX_FRAME_BYTES, `${name} is over ${MAX_FRAME_BYTES} bytes`);
      assert.equal(frame.v, 1);
    });
  }

  it('cover every message type', () => {
    const covered = new Set(fixtures('valid/messages').map(([, frame]) => frame.type));
    assert.deepEqual(knownTypes.filter((t) => !covered.has(t)), []);
  });
});

describe('valid manifest fixtures', () => {
  for (const [name, manifest] of fixtures('valid/manifest')) {
    it(`${name} passes manifest.schema.json`, () => {
      assert.ok(validateManifest(manifest), explain(validateManifest));
    });
  }
});

describe('invalid message fixtures', () => {
  for (const [name, frame] of fixtures('invalid/messages')) {
    it(`${name} fails message.schema.json`, () => {
      assert.equal(validateMessage(frame), false);
    });
  }
});

describe('invalid manifest fixtures', () => {
  for (const [name, manifest] of fixtures('invalid/manifest')) {
    it(`${name} fails manifest.schema.json`, () => {
      assert.equal(validateManifest(manifest), false);
    });
  }
});

describe('schemas', () => {
  it('every message schema requires v through the envelope', () => {
    for (const type of knownTypes) {
      const schema = readJson(join(SCHEMA_DIR, 'messages', `${type}.schema.json`));
      assert.equal(schema.$ref, '../envelope.schema.json', type);
    }
    assert.ok(readJson(join(SCHEMA_DIR, 'envelope.schema.json')).required.includes('v'));
  });
});

function loadSchemas() {
  const instance = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(instance);
  for (const file of schemaFiles(SCHEMA_DIR)) instance.addSchema(readJson(file));
  return instance;
}

function schemaFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return schemaFiles(path);
    return entry.name.endsWith('.schema.json') ? [path] : [];
  });
}

function fixtures(sub) {
  const dir = join(HERE, sub);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8');
      return [f, JSON.parse(raw), raw];
    });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function explain(validate) {
  return JSON.stringify(validate.errors, null, 2);
}
