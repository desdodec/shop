import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.14.0/dist/maplibre-gl.mjs';

const config = window.STREET_FACE_CONFIG;
const collection = config?.collection;

if (
  !config?.supabaseUrl
  || !config?.supabasePublishableKey
  || !config?.mockupBaseUrl
  || !collection?.id
  || !collection?.name
  || !collection?.designCodePrefix
  || !collection?.geojsonUrl
  || !collection?.mapStyle
) {
  throw new Error('Storefront configuration is missing.');
}

const LEGACY_STORAGE_KEY = 'street-face-selected-designs-v1';
const STORAGE_KEY = `${LEGACY_STORAGE_KEY}:${collection.id}`;
const SUGGESTION_LIMIT = 12;
const TYPEAHEAD_DELAY_MS = 120;
const MAP_PAGE_SIZE = 50;

const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const results = document.querySelector('#results');
const status = document.querySelector('#status');
const resultCount = document.querySelector('#result-count');
const resultsTitle = document.querySelector('#results-title');
const template = document.querySelector('#design-template');
const clearSearchButton = document.querySelector('#clear-search');
const selectionTray = document.querySelector('#selection-tray');
const selectedDesignsContainer = document.querySelector('#selected-designs');
const selectedDesignTemplate = document.querySelector('#selected-design-template');
const clearSelectionButton = document.querySelector('#clear-selection');
const copyDesignIdsButton = document.querySelector('#copy-design-ids');
const mapElement = document.querySelector('#street-map');
const mapStatus = document.querySelector('#map-status');

let currentItems = [];
let selectedDesigns = loadSelections();
let debounceTimer = null;
let requestVersion = 0;
let streetMap = null;
let mapPopup = null;
const mapItemsByDesignCode = new Map();

function applyCollectionCopy() {
  const pilot = document.querySelector('.pilot');
  const heroCopy = document.querySelector('.hero-copy');

  if (pilot) pilot.textContent = `${collection.name} collection`;
  if (heroCopy) {
    heroCopy.textContent = `These are the streets currently available in our ${collection.name} test collection. Tap a street on the map, or start typing its name below.`;
  }
}

function loadSelections() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
      ?? (collection.id === 'hebden-bridge' ? localStorage.getItem(LEGACY_STORAGE_KEY) : null);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item?.design_code && item?.street_name);
  } catch {
    return [];
  }
}

function saveSelections() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedDesigns));
}

function isSelected(designCode) {
  return selectedDesigns.some((item) => item.design_code === designCode);
}

function assetUrl(key) {
  const encoded = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${config.mockupBaseUrl}/${encoded}`;
}

async function searchCatalogue(searchText = '', limit = SUGGESTION_LIMIT, offset = 0) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/search_catalogue`, {
    method: 'POST',
    headers: {
      apikey: config.supabasePublishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      search_text: searchText,
      result_limit: limit,
      result_offset: offset,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Catalogue request failed (${response.status}): ${detail}`);
  }

  return response.json();
}

async function loadAllCatalogueItems() {
  const items = [];
  let offset = 0;

  while (true) {
    const page = await searchCatalogue('', MAP_PAGE_SIZE, offset);
    items.push(...page);
    if (page.length < MAP_PAGE_SIZE) break;
    offset += page.length;
  }

  return items;
}

function updateCardSelection(card, item) {
  const button = card.querySelector('.select-design');
  const selected = isSelected(item.design_code);

  card.classList.toggle('selected', selected);
  button.textContent = selected ? 'Selected — remove' : 'Choose this design';
  button.setAttribute('aria-pressed', String(selected));
}

function updateFinderSelection(option, item) {
  const selected = isSelected(item.design_code);
  const chooseButton = option.querySelector('.street-finder-choice');

  option.classList.toggle('selected', selected);
  chooseButton.textContent = selected ? 'Selected' : 'Choose';
  chooseButton.setAttribute('aria-pressed', String(selected));
  chooseButton.setAttribute(
    'aria-label',
    selected
      ? `Remove ${item.street_name} from selected designs`
      : `Choose ${item.street_name}`,
  );
}

function mapSelectionExpression(selectedValue, defaultValue) {
  const selectedCodes = selectedDesigns.map((item) => item.design_code);
  if (!selectedCodes.length) return defaultValue;
  return [
    'case',
    ['in', ['get', 'design_code'], ['literal', selectedCodes]],
    selectedValue,
    defaultValue,
  ];
}

function refreshMapSelections() {
  if (!streetMap?.getLayer('available-streets')) return;
  streetMap.setPaintProperty(
    'available-streets',
    'line-color',
    mapSelectionExpression('#8c3f22', '#191919'),
  );
  streetMap.setPaintProperty(
    'available-streets',
    'line-width',
    mapSelectionExpression(7, 4),
  );
}

function renderSelectionTray() {
  selectedDesignsContainer.replaceChildren();
  selectionTray.hidden = selectedDesigns.length === 0;

  for (const item of selectedDesigns) {
    const fragment = selectedDesignTemplate.content.cloneNode(true);
    fragment.querySelector('.selected-street').textContent = item.street_name;
    fragment.querySelector('.selected-code').textContent = item.design_code;

    const removeButton = fragment.querySelector('.remove-selected');
    removeButton.setAttribute('aria-label', `Remove ${item.street_name} (${item.design_code})`);
    removeButton.addEventListener('click', () => toggleSelection(item));

    selectedDesignsContainer.append(fragment);
  }
}

function refreshVisibleCards() {
  const cards = results.querySelectorAll('.design-card');
  cards.forEach((card, index) => {
    const item = currentItems[index];
    if (item) updateCardSelection(card, item);
  });
}

function refreshFinderSelections() {
  const options = results.querySelectorAll('.street-finder-option');
  options.forEach((option, index) => {
    const item = currentItems[index];
    if (item) updateFinderSelection(option, item);
  });
}

function updateMapStatus() {
  if (!mapStatus || !mapItemsByDesignCode.size) return;
  mapStatus.textContent = `${mapItemsByDesignCode.size} street designs available${selectedDesigns.length ? ` · ${selectedDesigns.length} selected` : ''}`;
}

function toggleSelection(item) {
  if (isSelected(item.design_code)) {
    selectedDesigns = selectedDesigns.filter((selected) => selected.design_code !== item.design_code);
  } else {
    selectedDesigns = [
      ...selectedDesigns,
      {
        design_code: item.design_code,
        street_name: item.street_name,
        locality: item.locality,
      },
    ];
  }

  saveSelections();
  renderSelectionTray();
  refreshVisibleCards();
  refreshFinderSelections();
  refreshMapSelections();
  updateMapStatus();
}

function updateUrl(query) {
  const url = new URL(window.location.href);
  if (query) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.delete('q');
  }
  history.replaceState(null, '', url);
}

function renderDesign(item, { scroll = false } = {}) {
  currentItems = [item];
  results.replaceChildren();
  results.classList.remove('finder-results');
  resultsTitle.textContent = 'Your street design';
  resultCount.textContent = item.design_code;
  status.textContent = `${item.street_name} selected for preview.`;

  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector('.design-card');
  const front = fragment.querySelector('.front-image');
  const rear = fragment.querySelector('.rear-image');
  const button = fragment.querySelector('.select-design');

  fragment.querySelector('.street-name').textContent = item.street_name;
  fragment.querySelector('.locality').textContent = item.locality;
  fragment.querySelector('.design-code').textContent = item.design_code;

  front.src = assetUrl(item.front_mockup_key);
  front.alt = `${item.street_name} mug front preview`;
  rear.src = assetUrl(item.rear_mockup_key);
  rear.alt = `${item.street_name} mug reverse preview`;

  updateCardSelection(card, item);
  button.addEventListener('click', () => toggleSelection(item));
  results.append(fragment);

  input.value = item.street_name;
  clearSearchButton.hidden = false;
  updateUrl(item.street_name);

  if (scroll) {
    document.querySelector('.results-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderSuggestions(items, query) {
  currentItems = items;
  results.replaceChildren();
  results.classList.add('finder-results');
  resultsTitle.textContent = 'Matching streets';
  resultCount.textContent = `${items.length} match${items.length === 1 ? '' : 'es'}`;

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<h3>No matching street found</h3><p>Try fewer letters or a different spelling.</p>';
    results.append(empty);
    status.textContent = `No streets containing “${query}”.`;
    return;
  }

  const list = document.createElement('div');
  list.className = 'street-finder-list';

  for (const item of items) {
    const option = document.createElement('div');
    option.className = 'street-finder-option';

    const details = document.createElement('button');
    details.className = 'street-finder-preview';
    details.type = 'button';
    details.innerHTML = `<span>${escapeHtml(item.street_name)}</span><small>${escapeHtml(item.locality || '')}</small>`;
    details.setAttribute('aria-label', `Preview ${item.street_name}`);
    details.addEventListener('click', () => renderDesign(item));

    const chooseButton = document.createElement('button');
    chooseButton.className = 'street-finder-choice';
    chooseButton.type = 'button';
    chooseButton.addEventListener('click', () => toggleSelection(item));

    option.append(details, chooseButton);
    updateFinderSelection(option, item);
    list.append(option);
  }

  results.append(list);
  status.textContent = items.length === 1
    ? 'Choose the street, or preview the mug design.'
    : `Choose one or more streets from ${items.length} matches, or tap a street name to preview it.`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function resetFinder() {
  requestVersion += 1;
  currentItems = [];
  results.replaceChildren();
  results.classList.add('finder-results');
  resultsTitle.textContent = 'Matching streets';
  resultCount.textContent = '';
  status.textContent = 'Start typing to find a street.';
  clearSearchButton.hidden = true;
  updateUrl('');
}

async function runTypeahead(query) {
  const trimmed = query.trim();
  clearSearchButton.hidden = !trimmed;
  updateUrl(trimmed);

  if (trimmed.length < 2) {
    currentItems = [];
    results.replaceChildren();
    resultsTitle.textContent = 'Matching streets';
    resultCount.textContent = '';
    status.textContent = trimmed.length === 1
      ? 'Type one more letter to see matching streets.'
      : 'Start typing to find a street.';
    return;
  }

  const version = ++requestVersion;
  status.textContent = 'Finding streets…';
  results.setAttribute('aria-busy', 'true');

  try {
    const items = await searchCatalogue(trimmed);
    if (version !== requestVersion) return;
    renderSuggestions(items, trimmed);
  } catch (error) {
    if (version !== requestVersion) return;
    console.error(error);
    currentItems = [];
    results.replaceChildren();
    resultCount.textContent = '';
    status.textContent = 'The street finder could not be loaded. Please try again.';
  } finally {
    if (version === requestVersion) results.removeAttribute('aria-busy');
  }
}

function mapFeatureIndex(item) {
  const code = String(item.design_code || '');
  if (!code.startsWith(collection.designCodePrefix)) return null;
  const suffix = code.slice(collection.designCodePrefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}

function extendBoundsFromCoordinates(bounds, coordinates) {
  if (!Array.isArray(coordinates)) return;
  if (
    coordinates.length >= 2
    && typeof coordinates[0] === 'number'
    && typeof coordinates[1] === 'number'
  ) {
    bounds.extend([coordinates[0], coordinates[1]]);
    return;
  }
  for (const part of coordinates) extendBoundsFromCoordinates(bounds, part);
}

async function initialiseStreetMap() {
  if (!mapElement || !mapStatus) return;

  try {
    const [geojsonResponse, catalogueItems] = await Promise.all([
      fetch(collection.geojsonUrl),
      loadAllCatalogueItems(),
    ]);

    if (!geojsonResponse.ok) {
      throw new Error(`Street map data failed (${geojsonResponse.status})`);
    }

    const geojson = await geojsonResponse.json();
    const catalogueByFeatureIndex = new Map();
    mapItemsByDesignCode.clear();

    for (const item of catalogueItems) {
      const featureIndex = mapFeatureIndex(item);
      if (featureIndex !== null) catalogueByFeatureIndex.set(featureIndex, item);
      mapItemsByDesignCode.set(item.design_code, item);
    }

    const availableFeatures = geojson.features
      .map((feature, index) => {
        const item = catalogueByFeatureIndex.get(index);
        if (!item) return null;
        return {
          ...feature,
          properties: {
            ...feature.properties,
            design_code: item.design_code,
            street_name: item.street_name,
          },
        };
      })
      .filter(Boolean);

    if (!availableFeatures.length) {
      throw new Error('No available street features were found.');
    }

    streetMap = new maplibregl.Map({
      container: mapElement,
      style: collection.mapStyle,
      center: collection.initialMapCenter ?? [-2.0, 53.74],
      zoom: collection.initialMapZoom ?? 11,
      attributionControl: true,
    });

    streetMap.scrollZoom.disable();
    streetMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    streetMap.on('load', () => {
      streetMap.addSource('available-streets-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: availableFeatures },
      });

      streetMap.addLayer({
        id: 'available-streets-hit-area',
        type: 'line',
        source: 'available-streets-source',
        paint: {
          'line-color': '#000000',
          'line-opacity': 0,
          'line-width': 16,
        },
      });

      streetMap.addLayer({
        id: 'available-streets',
        type: 'line',
        source: 'available-streets-source',
        paint: {
          'line-color': mapSelectionExpression('#8c3f22', '#191919'),
          'line-width': mapSelectionExpression(7, 4),
          'line-opacity': 0.9,
        },
      });

      streetMap.addLayer({
        id: 'hovered-street',
        type: 'line',
        source: 'available-streets-source',
        filter: ['==', ['get', 'design_code'], ''],
        paint: {
          'line-color': '#1976d2',
          'line-width': 9,
          'line-opacity': 1,
        },
      });

      const bounds = new maplibregl.LngLatBounds();
      for (const feature of geojson.features) {
        extendBoundsFromCoordinates(bounds, feature.geometry?.coordinates);
      }
      if (!bounds.isEmpty()) {
        streetMap.fitBounds(bounds, { padding: 34, maxZoom: 15, duration: 0 });
      }

      mapPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 10,
      });

      streetMap.on('mouseenter', 'available-streets-hit-area', () => {
        streetMap.getCanvas().style.cursor = 'pointer';
      });

      streetMap.on('mouseleave', 'available-streets-hit-area', () => {
        streetMap.getCanvas().style.cursor = '';
        streetMap.setFilter('hovered-street', ['==', ['get', 'design_code'], '']);
        mapPopup.remove();
      });

      streetMap.on('mousemove', 'available-streets-hit-area', (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const designCode = feature.properties?.design_code || '';
        const streetName = feature.properties?.street_name || 'Available street';
        const action = isSelected(designCode) ? 'Selected — click to remove' : 'Click to choose';
        streetMap.setFilter('hovered-street', ['==', ['get', 'design_code'], designCode]);
        mapPopup
          .setLngLat(event.lngLat)
          .setText(`${streetName} · ${action}`)
          .addTo(streetMap);
      });

      streetMap.on('click', 'available-streets-hit-area', (event) => {
        const feature = event.features?.[0];
        const designCode = feature?.properties?.design_code;
        const item = mapItemsByDesignCode.get(designCode);
        if (!item) return;

        const wasSelected = isSelected(item.design_code);
        toggleSelection(item);
        mapPopup
          .setLngLat(event.lngLat)
          .setText(`${item.street_name} · ${wasSelected ? 'Removed' : 'Selected'}`)
          .addTo(streetMap);
      });

      updateMapStatus();
    });

    streetMap.on('error', (event) => {
      console.error('Map error', event.error || event);
    });
  } catch (error) {
    console.error(error);
    mapStatus.textContent = 'The map could not be loaded. Use the street finder below.';
    mapElement.classList.add('map-error');
    mapElement.textContent = 'Street map unavailable';
  }
}

function scheduleTypeahead() {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => runTypeahead(input.value), TYPEAHEAD_DELAY_MS);
}

input.addEventListener('input', scheduleTypeahead);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  window.clearTimeout(debounceTimer);

  if (currentItems.length === 1) {
    renderDesign(currentItems[0]);
    return;
  }

  runTypeahead(input.value);
});

clearSearchButton.addEventListener('click', () => {
  input.value = '';
  resetFinder();
  input.focus();
});

clearSelectionButton.addEventListener('click', () => {
  selectedDesigns = [];
  saveSelections();
  renderSelectionTray();
  refreshVisibleCards();
  refreshFinderSelections();
  refreshMapSelections();
  updateMapStatus();
});

copyDesignIdsButton.addEventListener('click', async () => {
  const codes = selectedDesigns.map((item) => item.design_code).join(', ');
  try {
    await navigator.clipboard.writeText(codes);
    copyDesignIdsButton.textContent = 'Copied';
    window.setTimeout(() => {
      copyDesignIdsButton.textContent = 'Copy Design IDs';
    }, 1800);
  } catch {
    window.prompt('Copy these Design IDs:', codes);
  }
});

const initialQuery = new URL(window.location.href).searchParams.get('q')?.trim() ?? '';
applyCollectionCopy();
input.value = initialQuery;
renderSelectionTray();
initialiseStreetMap();

if (initialQuery) {
  runTypeahead(initialQuery);
} else {
  resetFinder();
}
