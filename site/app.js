const config = window.STREET_FACE_CONFIG;

if (!config?.supabaseUrl || !config?.supabasePublishableKey || !config?.mockupBaseUrl) {
  throw new Error('Storefront configuration is missing.');
}

const STORAGE_KEY = 'street-face-selected-designs-v1';
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
const mapLayersByDesignCode = new Map();

function loadSelections() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

function mapLineStyle(item) {
  const selected = isSelected(item.design_code);
  return {
    color: selected ? '#8c3f22' : '#191919',
    weight: selected ? 8 : 6,
    opacity: selected ? 1 : 0.78,
  };
}

function refreshMapSelections() {
  for (const [designCode, layers] of mapLayersByDesignCode.entries()) {
    const item = { design_code: designCode };
    for (const layer of layers) {
      layer.setStyle(mapLineStyle(item));
    }
  }
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

function designStreetId(item) {
  const match = /^HB-(\d{4})$/.exec(item.design_code || '');
  return match ? Number(match[1]) : null;
}

async function initialiseStreetMap() {
  if (!mapElement || !mapStatus) return;
  if (!window.L) {
    mapStatus.textContent = 'The map could not be loaded. Use the street finder below.';
    return;
  }

  try {
    const [geojsonResponse, catalogueItems] = await Promise.all([
      fetch('/data/hebden_bridge_streets.geojson'),
      loadAllCatalogueItems(),
    ]);

    if (!geojsonResponse.ok) {
      throw new Error(`Street map data failed (${geojsonResponse.status})`);
    }

    const geojson = await geojsonResponse.json();
    const catalogueByStreetId = new Map();

    for (const item of catalogueItems) {
      const streetId = designStreetId(item);
      if (streetId !== null) catalogueByStreetId.set(streetId, item);
    }

    const availableFeatures = geojson.features
      .map((feature, index) => {
        const item = catalogueByStreetId.get(index);
        if (!item) return null;
        return {
          ...feature,
          properties: {
            ...feature.properties,
            catalogueItem: item,
          },
        };
      })
      .filter(Boolean);

    if (!availableFeatures.length) {
      throw new Error('No available street features were found.');
    }

    streetMap = window.L.map(mapElement, {
      scrollWheelZoom: false,
      zoomControl: true,
      attributionControl: false,
    });

    const contextLayer = window.L.geoJSON(geojson, {
      interactive: false,
      style: {
        color: '#c9c3b8',
        weight: 2,
        opacity: 0.7,
      },
    }).addTo(streetMap);

    const geoLayer = window.L.geoJSON(
      { type: 'FeatureCollection', features: availableFeatures },
      {
        style: (feature) => mapLineStyle(feature.properties.catalogueItem),
        onEachFeature: (feature, layer) => {
          const item = feature.properties.catalogueItem;
          const existing = mapLayersByDesignCode.get(item.design_code) || [];
          existing.push(layer);
          mapLayersByDesignCode.set(item.design_code, existing);

          layer.bindTooltip(item.street_name, { sticky: true });
          layer.on('mouseover', () => {
            if (!isSelected(item.design_code)) layer.setStyle({ weight: 9, opacity: 1 });
          });
          layer.on('mouseout', () => layer.setStyle(mapLineStyle(item)));
          layer.on('click', () => renderDesign(item, { scroll: true }));
        },
      },
    ).addTo(streetMap);

    streetMap.fitBounds(contextLayer.getBounds(), { padding: [18, 18] });
    mapStatus.textContent = `${catalogueItems.length} street designs available`;
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
input.value = initialQuery;
renderSelectionTray();
initialiseStreetMap();

if (initialQuery) {
  runTypeahead(initialQuery);
} else {
  resetFinder();
}
