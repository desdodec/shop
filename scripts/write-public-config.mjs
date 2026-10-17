import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const output = resolve(root, 'site', 'config.js');
const collectionId = process.env.COLLECTION_ID?.trim() || 'hebden-bridge';
const collectionManifestPath = resolve(root, 'collections', `${collectionId}.json`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.replace(/\/+$/, '');
}

const collection = JSON.parse(await readFile(collectionManifestPath, 'utf8'));

for (const key of [
  'id',
  'name',
  'datasetId',
  'designCodePrefix',
  'geojsonSource',
  'publicGeojsonUrl',
  'mapStyle',
]) {
  if (!collection[key]) {
    throw new Error(`Collection manifest ${collectionId} is missing ${key}`);
  }
}

const sourceGeojson = resolve(root, collection.geojsonSource);
const publicGeojson = resolve(
  root,
  'site',
  collection.publicGeojsonUrl.replace(/^\/+/, ''),
);

const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
  mockupBaseUrl: required('MOCKUP_BASE_URL'),
  collection: {
    id: collection.id,
    name: collection.name,
    datasetId: collection.datasetId,
    designCodePrefix: collection.designCodePrefix,
    geojsonUrl: collection.publicGeojsonUrl,
    mapStyle: collection.mapStyle,
    initialMapCenter: collection.initialMapCenter ?? [-2.0, 53.74],
    initialMapZoom: collection.initialMapZoom ?? 11,
  },
};

await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `window.STREET_FACE_CONFIG = ${JSON.stringify(config, null, 2)};\n`,
  'utf8',
);

await mkdir(dirname(publicGeojson), { recursive: true });
await copyFile(sourceGeojson, publicGeojson);

console.log(`Collection: ${collection.name} (${collection.id})`);
console.log(`Wrote ${output}`);
console.log(`Published ${publicGeojson}`);
