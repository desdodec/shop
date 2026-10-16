const config = window.STREET_FACE_CONFIG;

if (!config?.supabaseUrl || !config?.supabasePublishableKey || !config?.mockupBaseUrl) {
  throw new Error('Storefront configuration is missing.');
}

const STORAGE_KEY = 'street-face-selected-designs-v1';
const SUGGESTION_LIMIT = 12;
const TYPEAHEAD_DELAY_MS = 120;

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

let currentItems = [];
let selectedDesigns = loadSelections();
let debounceTimer = null;
let requestVersion = 0;

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

async function searchCatalogue(searchText = '', limit = SUGGESTION_LIMIT) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/search_catalogue`, {
    method: 'POST',
    headers: {
      apikey: config.supabasePublishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      search_text: searchText,
      result_limit: limit,
      result_offset: 0,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Catalogue request failed (${response.status}): ${detail}`);
  }

  return response.json();
}

function updateCardSelection(card, item) {
  const button = card.querySelector('.select-design');
  const selected = isSelected(item.design_code);

  card.classList.toggle('selected', selected);
  button.textContent = selected ? 'Selected — remove' : 'Choose this design';
  button.setAttribute('aria-pressed', String(selected));
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

function renderDesign(item) {
  currentItems = [item];
  results.replaceChildren();
  results.classList.remove('finder-results');
  resultsTitle.textContent = 'Your street design';
  resultCount.textContent = item.design_code;
  status.textContent = `${item.street_name} selected.`;

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
    const button = document.createElement('button');
    button.className = 'street-finder-option';
    button.type = 'button';
    button.innerHTML = `<span>${escapeHtml(item.street_name)}</span><small>${escapeHtml(item.locality || '')}</small>`;
    button.addEventListener('click', () => renderDesign(item));
    list.append(button);
  }

  results.append(list);
  status.textContent = `Choose your street from ${items.length} match${items.length === 1 ? '' : 'es'}.`;
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

if (initialQuery) {
  runTypeahead(initialQuery);
} else {
  resetFinder();
}
