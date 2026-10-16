const config = window.STREET_FACE_CONFIG;

if (!config?.supabaseUrl || !config?.supabasePublishableKey || !config?.mockupBaseUrl) {
  throw new Error('Storefront configuration is missing.');
}

const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const results = document.querySelector('#results');
const status = document.querySelector('#status');
const resultCount = document.querySelector('#result-count');
const template = document.querySelector('#design-template');

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

function render(items, query) {
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
    const note = fragment.querySelector('.selection-note');

    fragment.querySelector('.street-name').textContent = item.street_name;
    fragment.querySelector('.locality').textContent = item.locality;
    fragment.querySelector('.design-code').textContent = item.design_code;

    front.src = assetUrl(item.front_mockup_key);
    front.alt = `${item.street_name} mug front preview`;
    rear.src = assetUrl(item.rear_mockup_key);
    rear.alt = `${item.street_name} mug reverse preview`;

    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.design_code);
        note.textContent = `${item.design_code} copied. Keep this Design ID for checkout.`;
      } catch {
        note.textContent = `Your Design ID is ${item.design_code}. Keep it for checkout.`;
      }
      note.hidden = false;
      card.classList.add('selected');
    });

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
  results.setAttribute('aria-busy', 'true');

  try {
    const items = await searchCatalogue(query);
    render(items, query);
  } catch (error) {
    console.error(error);
    results.replaceChildren();
    status.textContent = 'The catalogue could not be loaded. Please try again.';
  } finally {
    results.removeAttribute('aria-busy');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = input.value.trim();
  const url = new URL(window.location.href);
  if (query) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.delete('q');
  }
  history.replaceState(null, '', url);
  runSearch(query);
});

const initialQuery = new URL(window.location.href).searchParams.get('q')?.trim() ?? '';
input.value = initialQuery;
runSearch(initialQuery);
