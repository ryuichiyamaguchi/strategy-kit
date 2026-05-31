import {
  PREVIEW_STORAGE_KEY_PREFIX,
  buildDraftPreviewModel,
} from '../phase0/draft-preview.js';

function qs(id) {
  return document.getElementById(id);
}

function createEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value === false || value == null) return;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  });
  children.flat().forEach((child) => {
    if (child == null) return;
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  });
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function getPreviewId() {
  return new URLSearchParams(window.location.search).get('id') || '';
}

async function loadPreviewRecord(id) {
  if (!id) return null;
  const key = `${PREVIEW_STORAGE_KEY_PREFIX}${id}`;
  const stored = await chrome.storage.local.get([key]);
  return stored?.[key] || null;
}

function renderToc(model) {
  const toc = qs('toc');
  clear(toc);
  model.sections.forEach((section, index) => {
    const href = `#section-${index + 1}`;
    toc.appendChild(createEl('a', { href, text: section.heading || `Section ${index + 1}` }));
  });
}

function renderTable(table) {
  const tableNode = createEl('table', { class: 'data-table' });
  const thead = createEl('thead');
  const headRow = createEl('tr');
  table.headers.forEach((header) => {
    headRow.appendChild(createEl('th', { text: header }));
  });
  thead.appendChild(headRow);
  tableNode.appendChild(thead);

  const tbody = createEl('tbody');
  table.rows.forEach((row) => {
    const rowNode = createEl('tr');
    row.forEach((cell) => {
      rowNode.appendChild(createEl('td', { text: cell }));
    });
    tbody.appendChild(rowNode);
  });
  tableNode.appendChild(tbody);
  return tableNode;
}

function renderMetricStrip(metrics) {
  return createEl(
    'div',
    { class: 'metric-strip' },
    metrics.map((metric) => createEl(
      'div',
      { class: 'metric-card' },
      createEl('span', { class: 'metric-label', text: metric.label }),
      createEl('strong', { text: metric.value || '未設定' })
    ))
  );
}

function forceClass(force, index) {
  const text = `${force.name || ''} ${force.detail || ''}`;
  if (/新規参入|new entrant/i.test(text)) return 'force-new-entry';
  if (/売り手|supplier/i.test(text)) return 'force-supplier';
  if (/買い手|buyer|顧客の交渉力/i.test(text)) return 'force-buyer';
  if (/代替|substitute/i.test(text)) return 'force-substitute';
  if (/既存競合|敵対|rivalry|競争/i.test(text)) return 'force-rivalry';
  return `force-extra force-extra-${index + 1}`;
}

function renderFramework(framework) {
  if (!framework) return null;
  if (framework.type === 'three-c') {
    return createEl(
      'div',
      { class: 'framework framework-3c' },
      framework.cards.map((card) => createEl(
        'div',
        { class: 'framework-card' },
        createEl('span', { class: 'framework-kicker', text: card.name }),
        createEl('strong', { text: card.label }),
        createEl('p', { text: card.detail || '該当情報を本文で確認' })
      ))
    );
  }

  if (framework.type === 'cross-3c') {
    return createEl(
      'div',
      { class: 'framework framework-cross-3c' },
      createEl(
        'div',
        { class: 'venn-board' },
        createEl('div', { class: 'venn-circle venn-customer', text: 'Customer' }),
        createEl('div', { class: 'venn-circle venn-company', text: 'Company' }),
        createEl('div', { class: 'venn-circle venn-competitor', text: 'Competitor' }),
        createEl('div', { class: 'venn-center', text: 'KSF / 競争優位' })
      ),
      createEl(
        'div',
        { class: 'overlap-list' },
        framework.overlaps.map((item) => createEl(
          'div',
          { class: 'overlap-item' },
          createEl('strong', { text: item.name }),
          createEl('p', { text: [item.detail, item.interpretation].filter(Boolean).join(' / ') })
        ))
      )
    );
  }

  if (framework.type === 'five-forces') {
    return createEl(
      'div',
      { class: 'framework framework-five-forces' },
      createEl(
        'div',
        { class: 'five-forces-map' },
        framework.forces.map((force, index) => createEl(
          'div',
          { class: `force-card ${forceClass(force, index)}` },
          createEl('strong', { text: force.name }),
          createEl('p', { text: force.detail }),
          createEl('span', { class: 'force-strength', text: force.strength || '強度未設定' })
        ))
      )
    );
  }

  if (framework.type === 'swot') {
    const q = framework.quadrants;
    return createEl(
      'div',
      { class: 'framework framework-swot' },
      createEl('div', { class: 'swot-cell swot-s' }, createEl('strong', { text: 'S 強み' }), createEl('p', { text: q.strengths })),
      createEl('div', { class: 'swot-cell swot-o' }, createEl('strong', { text: 'O 機会' }), createEl('p', { text: q.opportunities })),
      createEl('div', { class: 'swot-cell swot-w' }, createEl('strong', { text: 'W 弱み' }), createEl('p', { text: q.weaknesses })),
      createEl('div', { class: 'swot-cell swot-t' }, createEl('strong', { text: 'T 脅威' }), createEl('p', { text: q.threats }))
    );
  }

  if (framework.type === 'cross-swot') {
    return createEl(
      'div',
      { class: 'framework framework-cross-swot' },
      framework.actions.map((item) => createEl(
        'div',
        { class: 'cross-swot-card' },
        createEl('strong', { text: item.name }),
        createEl('p', { text: item.action || '一手未設定' }),
        createEl('span', { text: item.verdict || '判定未設定' })
      ))
    );
  }

  if (framework.type === 'unit-economics') {
    return createEl(
      'div',
      { class: 'framework framework-unit-economics' },
      renderMetricStrip(framework.metrics)
    );
  }

  return null;
}

function renderSection(section, index) {
  const sectionNode = createEl('section', {
    id: `section-${index + 1}`,
    class: 'content-section',
  });
  sectionNode.appendChild(
    createEl(
      'div',
      { class: 'section-heading-row' },
      createEl('span', { class: 'section-number', text: String(index + 1).padStart(2, '0') }),
      createEl('h2', { text: section.heading || `Section ${index + 1}` })
    )
  );

  const framework = renderFramework(section.framework);
  if (framework) sectionNode.appendChild(framework);

  section.paragraphs.forEach((paragraph) => {
    sectionNode.appendChild(createEl('p', { text: paragraph }));
  });

  if (section.bullets.length) {
    const list = createEl('ul');
    section.bullets.forEach((bullet) => {
      list.appendChild(createEl('li', { text: bullet }));
    });
    sectionNode.appendChild(list);
  }

  (section.tables || []).forEach((table) => {
    sectionNode.appendChild(renderTable(table));
  });

  return sectionNode;
}

function renderPreview(record) {
  const model = record?.model || buildDraftPreviewModel(record || {});
  document.title = `${model.displayTitle} | STRATEGY-KIT`;
  qs('kind-label').textContent = model.kindLabel;
  qs('preview-title').textContent = model.displayTitle;
  qs('preview-summary').textContent = model.summary || '要約は生成されていません。';

  renderToc(model);

  const list = qs('section-list');
  clear(list);
  model.sections.forEach((section, index) => {
    list.appendChild(renderSection(section, index));
  });

  const openDocBtn = qs('open-doc-btn');
  if (record?.sourceDocUrl) {
    openDocBtn.hidden = false;
    openDocBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: record.sourceDocUrl });
    });
  } else {
    openDocBtn.hidden = true;
  }
}

async function init() {
  qs('print-btn')?.addEventListener('click', () => window.print());
  try {
    const record = await loadPreviewRecord(getPreviewId());
    if (!record) throw new Error('Preview record is missing.');
    renderPreview(record);
  } catch (error) {
    console.error('[STRATEGY-KIT] draft preview failed:', error);
    qs('empty-state')?.classList.remove('hidden');
  }
}

init();
