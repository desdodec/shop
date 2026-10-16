import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const output = resolve(root, 'site', 'config.js');
const sourceGeojson = resolve(root, 'geojson', 'hebden_bridge_streets.geojson');
const publicGeojson = resolve(root, 'site', 'data', 'hebden_bridge_streets.geojson');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.replace(/\/+$/, '');
}

const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
  mockupBaseUrl: required('MOCKUP_BASE_URL'),
};

await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `window.STREET_FACE_CONFIG = ${JSON.stringify(config, null, 2)};\n`,
  'utf8',
);

await mkdir(dirname(publicGeojson), { recursive: true });
await copyFile(sourceGeojson, publicGeojson);

console.log(`Wrote ${output}`);
console.log(`Published ${publicGeojson}`);
