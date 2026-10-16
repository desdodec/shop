const config = window.STREET_FACE_CONFIG;

if (!config?.supabaseUrl || !config?.supabasePublishableKey || !config?.mockupBaseUrl) {
  throw new Error('Storefront configuration is missing.');
}

const STORAGE_KEY = 'street-face-selected-designs-v1';

const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const results = document.querySelector('#results');
const status = document.querySelector('#status');
const resultCount = document.querySelector('#result-count');
const template = document.querySelector('#design-template');
const clearSearchButton = document.querySelector('#clear-search');
const selectionTray = document.querySelector('#selection-tray');
const selectedDesignsContainer = document.querySelector('#selected-designs');
const selectedDesignTemplate = document.querySelector('#selected-design-template');
const clearSelectionButton = document.querySelector('#clear-selection');
const copyDesignIdsButton = document.querySelector('#copy-design-ids');

let currentItems = [];
let selectedDesigns = loadSelections();

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

async function searchCatalogue(searchText = '') {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/search_catalogue`, {
    method: 'POST',
    headers: {
      apikey: config.supabasePublishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      search_text: searchText,
      result_limit: 24,
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

function render(items, query) {
  currentItems = items;
  results.replaceChildren();
  resultCount.textContent = `${items.length} result${items.length === 1 ? '' : 's'}`;

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<h3>No matching street found</h3><p>Try a shorter street name or a Design ID such as HB-0024.</p>';
    results.append(empty);
    return;
  }

  for (const item of items) {
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
  }

  if (query) {
    status.textContent = `Showing matches for “${query}”.`;
  } else {
    status.textContent = 'Showing a selection of available streets.';
  }
}

async function runSearch(query = '') {
  status.textContent = 'Searching…';
  resultCount.textContent = '';
  clearSearchButton.hidden = !query;
  results.setAttribute('aria-busy', 'true');

  try {
    const items = await searchCatalogue(query);
    render(items, query);
  } catch (error) {
    console.error(error);
    currentItems = [];
    results.replaceChildren();
    status.textContent = 'The catalogue could not be loaded. Please try again.';
  } finally {
    results.removeAttribute('aria-busy');
  }
}

function setSearchQuery(query) {
  input.value = query;
  const url = new URL(window.location.href);
  if (query) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.delete('q');
  }
  history.replaceState(null, '', url);
  runSearch(query);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  setSearchQuery(input.value.trim());
});

clearSearchButton.addEventListener('click', () => {
  setSearchQuery('');
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
runSearch(initialQuery);
