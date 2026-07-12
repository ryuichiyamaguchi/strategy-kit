// STRATEGY-KIT task monitor
// The page surface shows only the active task. Mission route ownership stays in the side panel.
(function () {
  const STORAGE_KEY = 'sk_task_monitor_v1';
  const STALE_AFTER_MS = 10 * 60 * 1000;
  const COMPLETED_VISIBLE_MS = 15 * 1000;

  if (!globalThis.chrome?.storage?.local || globalThis.__strategyKitTaskMonitorLoaded) return;
  globalThis.__strategyKitTaskMonitorLoaded = true;

  let host = null;
  let card = null;
  let toggle = null;
  let compactLabel = null;
  let provider = null;
  let providerMark = null;
  let task = null;
  let meta = null;
  let eventText = null;
  let eventTime = null;
  let collapsed = false;
  let currentTabId = null;
  let currentOrigin = null;
  let completionTimer = null;
  let expiryTimer = null;

  function mount() {
    if (host) return;
    host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        left: 18px;
        bottom: 18px;
        z-index: 2147483646;
        width: min(390px, calc(100vw - 36px));
        color: #10233d;
        font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", sans-serif;
        font-synthesis: none;
      }
      [hidden] { display: none !important; }
      .card {
        overflow: hidden;
        border: 1px solid #cbd9e7;
        border-radius: 14px;
        background: rgba(255, 255, 255, .97);
        box-shadow: 0 16px 40px rgba(16, 35, 61, .18);
        backdrop-filter: blur(14px);
      }
      .head {
        display: flex;
        align-items: center;
        min-height: 42px;
        gap: 9px;
        padding: 9px 12px;
        border-bottom: 1px solid #e4ebf2;
      }
      .live {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 999px;
        background: #53c8bf;
        box-shadow: 0 0 0 4px rgba(83, 200, 191, .16);
      }
      .brand {
        min-width: 0;
        flex: 1;
        color: #246e65;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .035em;
      }
      .compact-label {
        display: none;
        min-width: 0;
        flex: 1;
        overflow: hidden;
        color: #10233d;
        font-size: 12px;
        font-weight: 750;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .toggle {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 7px;
        color: #6c7f92;
        background: transparent;
        cursor: pointer;
      }
      .toggle:hover { background: #edf2f7; color: #10233d; }
      .body { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 11px; padding: 12px; }
      .provider-mark {
        display: grid;
        width: 40px;
        height: 40px;
        place-items: center;
        border-radius: 11px;
        color: #fff;
        background: #3977ee;
        font-size: 15px;
        font-weight: 900;
      }
      .provider { margin: 0 0 2px; color: #3977ee; font-size: 11px; font-weight: 800; }
      .task { margin: 0; color: #10233d; font-size: 14px; font-weight: 800; line-height: 1.45; }
      .meta { margin: 4px 0 0; color: #667b90; font-size: 11px; line-height: 1.4; }
      .event {
        display: flex;
        gap: 8px;
        margin: 0 12px;
        padding: 9px 0 11px;
        border-top: 1px solid #e4ebf2;
        color: #687b8f;
        font-size: 10px;
        line-height: 1.45;
      }
      .event strong { color: #3977ee; }
      .card[data-status="retrying"] .live { background: #f1a84a; box-shadow: 0 0 0 4px rgba(241, 168, 74, .18); }
      .card[data-status="blocked"] .live { background: #db5c55; box-shadow: 0 0 0 4px rgba(219, 92, 85, .16); }
      .card[data-status="completed"] .live { background: #53c8bf; }
      .card.is-collapsed .body,
      .card.is-collapsed .event { display: none; }
      .card.is-collapsed .head { border-bottom: 0; }
      .card.is-collapsed .brand { display: none; }
      .card.is-collapsed .compact-label { display: block; }
      @media (max-width: 560px) {
        :host { left: 12px; bottom: 12px; width: min(350px, calc(100vw - 24px)); }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation: none !important; transition: none !important; }
      }
    </style>
    <section class="card" role="status" aria-live="polite" data-status="running">
      <header class="head">
        <span class="live" aria-hidden="true"></span>
        <span class="brand">STRATEGY-KIT · タスク実況</span>
        <span class="compact-label"></span>
        <button class="toggle" type="button" aria-expanded="true" aria-label="タスク実況を折りたたむ">⌃</button>
      </header>
      <div class="body">
        <span class="provider-mark" aria-hidden="true">AI</span>
        <div>
          <p class="provider"></p>
          <p class="task"></p>
          <p class="meta"></p>
        </div>
      </div>
      <p class="event"><span>直近</span><strong></strong><span class="event-time"></span></p>
    </section>
  `;
    card = shadow.querySelector('.card');
    toggle = shadow.querySelector('.toggle');
    compactLabel = shadow.querySelector('.compact-label');
    provider = shadow.querySelector('.provider');
    providerMark = shadow.querySelector('.provider-mark');
    task = shadow.querySelector('.task');
    meta = shadow.querySelector('.meta');
    eventText = shadow.querySelector('.event strong');
    eventTime = shadow.querySelector('.event-time');
    toggle.addEventListener('click', () => setCollapsed(!collapsed));
    document.documentElement.appendChild(host);
  }

  function unmount() {
    if (completionTimer) clearTimeout(completionTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    completionTimer = null;
    expiryTimer = null;
    host?.remove();
    host = card = toggle = compactLabel = provider = providerMark = task = meta = eventText = eventTime = null;
    collapsed = false;
  }

  function setCollapsed(next) {
    collapsed = !!next;
    card.classList.toggle('is-collapsed', collapsed);
    toggle.textContent = collapsed ? '⌄' : '⌃';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'タスク実況を展開する' : 'タスク実況を折りたたむ');
  }

  function providerInitial(value) {
    const text = String(value || 'AI').trim();
    return text.slice(0, 1).toUpperCase() || 'AI';
  }

  function render(snapshot) {
    const updatedAt = Number(snapshot?.updatedAt || 0);
    const isStale = updatedAt > 0 && Date.now() - updatedAt > STALE_AFTER_MS;
    const isTargetTab = Number(snapshot?.targetTabId) === Number(currentTabId);
    const isTargetOrigin = snapshot?.targetOrigin === currentOrigin;
    const visible = !!snapshot && snapshot.visible !== false && snapshot.status !== 'idle' && !isStale && isTargetTab && isTargetOrigin;
    if (!visible) {
      unmount();
      return;
    }
    if (completionTimer) clearTimeout(completionTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    completionTimer = null;
    expiryTimer = null;
    mount();

    const status = String(snapshot.status || 'running');
    const taskLabel = String(snapshot.taskLabel || '処理内容を確認しています');
    const providerLabel = String(snapshot.provider || 'AI');
    const metaParts = [snapshot.taskCount, snapshot.eta].filter(Boolean).map(String);

    card.dataset.status = status;
    compactLabel.textContent = taskLabel;
    provider.textContent = providerLabel;
    providerMark.textContent = providerInitial(providerLabel);
    task.textContent = taskLabel;
    meta.textContent = metaParts.join(' · ');
    meta.hidden = metaParts.length === 0;
    eventText.textContent = String(snapshot.lastEvent || '状態を更新しました');
    eventTime.textContent = snapshot.relativeTime ? `· ${snapshot.relativeTime}` : '';
    if (status === 'completed') {
      completionTimer = setTimeout(unmount, COMPLETED_VISIBLE_MS);
    } else {
      const expiresIn = Math.max(0, STALE_AFTER_MS - (Date.now() - updatedAt));
      expiryTimer = setTimeout(unmount, expiresIn);
    }
  }

  chrome.runtime.sendMessage({ type: 'GET_TASK_MONITOR_CONTEXT' }).then((context) => {
    if (!context?.ok || !context.tabId || !context.origin) return;
    currentTabId = context.tabId;
    currentOrigin = context.origin;
    chrome.storage.local.get(STORAGE_KEY).then((values) => render(values?.[STORAGE_KEY])).catch(() => {});
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
      render(changes[STORAGE_KEY].newValue);
    });
  }).catch(() => {});
})();
