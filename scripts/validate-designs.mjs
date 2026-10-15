import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const CATALOGUE_PATH = path.join(ROOT, 'data', 'designs.json');

const ID_RE = /^HB-\d{4}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_STATUSES = new Set(['active', 'inactive', 'review']);
const REQUIRED_FIELDS = [
  'id',
  'streetName',
  'postcode',
  'locality',
  'slug',
  'frontPreview',
  'rearPreview',
  'frontPrintAsset',
  'rearPrintAsset',
  'status'
];

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function readCatalogue() {
  if (!fs.existsSync(CATALOGUE_PATH)) {
    throw new Error(`Catalogue not found: ${CATALOGUE_PATH}`);
  }

  const raw = fs.readFileSync(CATALOGUE_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('data/designs.json must contain a JSON array.');
  }

  return parsed;
}

function validateString(value, label, index) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`Record ${index + 1}: ${label} must be a non-empty string.`);
    return false;
  }
  return true;
}

function validate() {
  let designs;

  try {
    designs = readCatalogue();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }

  const ids = new Set();
  const slugs = new Set();
  const assetPaths = new Map();

  designs.forEach((design, index) => {
    if (!design || typeof design !== 'object' || Array.isArray(design)) {
      fail(`Record ${index + 1}: must be an object.`);
      return;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!(field in design)) {
        fail(`Record ${index + 1}: missing required field '${field}'.`);
      }
    }

    if (validateString(design.id, 'id', index)) {
      if (!ID_RE.test(design.id)) {
        fail(`Record ${index + 1}: id '${design.id}' must match HB-0001 format.`);
      }
      if (ids.has(design.id)) {
        fail(`Record ${index + 1}: duplicate id '${design.id}'.`);
      }
      ids.add(design.id);
    }

    validateString(design.streetName, 'streetName', index);
    validateString(design.postcode, 'postcode', index);
    validateString(design.locality, 'locality', index);

    if (validateString(design.slug, 'slug', index)) {
      if (!SLUG_RE.test(design.slug)) {
        fail(`Record ${index + 1}: slug '${design.slug}' is invalid.`);
      }
      if (slugs.has(design.slug)) {
        fail(`Record ${index + 1}: duplicate slug '${design.slug}'.`);
      }
      slugs.add(design.slug);
    }

    if (!VALID_STATUSES.has(design.status)) {
      fail(`Record ${index + 1}: status '${design.status}' must be active, inactive or review.`);
    }

    for (const field of ['frontPreview', 'rearPreview', 'frontPrintAsset', 'rearPrintAsset']) {
      if (!validateString(design[field], field, index)) continue;

      const normalized = design[field].replaceAll('\\', '/');
      if (normalized.startsWith('/') || normalized.includes('..')) {
        fail(`Record ${index + 1}: ${field} must be a safe relative asset path.`);
      }

      if (assetPaths.has(normalized)) {
        fail(`Record ${index + 1}: asset path '${normalized}' is already used by ${assetPaths.get(normalized)}.`);
      } else {
        assetPaths.set(normalized, `${design.id || `record ${index + 1}`} ${field}`);
      }
    }
  });

  if (process.exitCode) {
    console.error(`\nCatalogue validation failed for ${designs.length} record(s).`);
    return;
  }

  console.log(`Catalogue valid: ${designs.length} record(s).`);
  console.log(`Unique IDs: ${ids.size}`);
  console.log(`Unique slugs: ${slugs.size}`);
  console.log(`Unique asset paths: ${assetPaths.size}`);
}

validate();
