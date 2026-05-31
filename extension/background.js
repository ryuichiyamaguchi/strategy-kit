// STRATEGY-KIT Helper — background service worker
// 役割:
//   1) アクションクリックでサイドパネルを開く
//   2) サイドパネル ↔ content script のメッセージ中継
//   3) 初回起動時に既定設定を storage へ書き込む

import './phase0/phase0-smoke-test.js';

const DEFAULT_SETTINGS = {
  industry: 'generic',
  storeName: '',
  industryLabel: '',
  notation: '★', // プロンプト埋め込み記号
  lastPhase: 'phase-0',
  lastTab: 'phases',
  lastSegment: 'work',
  showSafetyNotice: true,
};

const AI_ORIGINS = {
  claude: 'https://claude.ai',
  chatgpt: 'https://chatgpt.com',
  gemini: 'https://gemini.google.com',
  manus: 'https://manus.im',
  genspark: 'https://www.genspark.ai',
  perplexity: 'https://www.perplexity.ai',
  grok: 'https://grok.com',
  notebooklm: 'https://notebooklm.google.com',
  'google-docs': 'https://docs.google.com',
};

function getOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (e) {
    return null;
  }
}

async function findLastFocusedTabForSite(site) {
  const expectedOrigin = AI_ORIGINS[site];
  if (!expectedOrigin) return null;

  const tabs = await chrome.tabs.query({ url: expectedOrigin + '/*' });
  if (!tabs || !tabs.length) return null;

  const focusedWindow = await chrome.windows.getLastFocused().catch(() => null);
  if (focusedWindow?.id) {
    const inFocusedWindow = tabs.find((tab) => tab.windowId === focusedWindow.id);
    if (inFocusedWindow) return inFocusedWindow;
  }

  return tabs[0];
}

// v0.11.x のフラット sk-state を v0.12 のプロジェクトスコープへ移行する。
// 旧キー: sk-state.placeholders.*, sk-state.automation.*, sk-state.diagram.* 等
// 新キー: sk-state.projects.{projectId}.{suffix}
// 旧キーは sk-state.legacy.{suffix} としてバックアップを残してから削除する。
async function migrateV011ToV012() {
  const all = await chrome.storage.local.get(null);
  const hasOldFormat = Object.keys(all).some(
    (k) =>
      k.startsWith('sk-state.') &&
      !k.startsWith('sk-state.ui.') &&
      !k.startsWith('sk-state.projects.') &&
      !k.startsWith('sk-state.legacy.')
  );
  const hasNewFormat = Object.keys(all).some((k) =>
    k.startsWith('sk-state.projects.')
  );
  if (!hasOldFormat || hasNewFormat) {
    return { migrated: false };
  }

  const projectId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'proj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  const now = new Date().toISOString();
  const setObj = {};
  const oldKeys = [];

  for (const k of Object.keys(all)) {
    if (!k.startsWith('sk-state.')) continue;
    if (
      k.startsWith('sk-state.ui.') ||
      k.startsWith('sk-state.projects.') ||
      k.startsWith('sk-state.legacy.')
    ) {
      continue;
    }
    const suffix = k.slice('sk-state.'.length);
    setObj['sk-state.projects.' + projectId + '.' + suffix] = all[k];
    setObj['sk-state.legacy.' + suffix] = all[k];
    oldKeys.push(k);
  }

  setObj['sk-state.projects.' + projectId + '.meta.id'] = projectId;
  setObj['sk-state.projects.' + projectId + '.meta.label'] = '既存案件（自動移行）';
  setObj['sk-state.projects.' + projectId + '.meta.createdAt'] = now;
  setObj['sk-state.projects.' + projectId + '.meta.updatedAt'] = now;
  setObj['sk-state.ui.activeProjectId'] = projectId;

  await chrome.storage.local.set(setObj);
  if (oldKeys.length > 0) {
    await chrome.storage.local.remove(oldKeys);
  }
  console.info(
    '[STRATEGY-KIT] migrated v0.11 flat state to v0.12 project',
    projectId,
    '(',
    oldKeys.length,
    'keys )'
  );
  return { migrated: true, projectId: projectId, migratedKeys: oldKeys.length };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const next = { ...DEFAULT_SETTINGS, ...current };
  await chrome.storage.sync.set(next);
  await chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

  if (details?.reason === 'install' || details?.reason === 'update') {
    try {
      await migrateV011ToV012();
    } catch (e) {
      console.warn('[STRATEGY-KIT] migration failed:', e);
    }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId) return;
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.warn('[STRATEGY-KIT] sidePanel.open failed:', e);
  }
});

// サイドパネルから「現在のタブにプロンプトを挿入してほしい」リクエストを受ける
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OPEN_OR_FOCUS_AI_TAB') {
    (async () => {
      try {
        const existingTab = await findLastFocusedTabForSite(message.site);
        if (existingTab?.id) {
          await chrome.tabs.update(existingTab.id, { active: true });
          if (existingTab.windowId) {
            await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
          }
          sendResponse({ ok: true, reused: true, tabId: existingTab.id });
          return;
        }

        const targetUrl = message.url || AI_ORIGINS[message.site];
        if (!targetUrl) {
          sendResponse({ ok: false, error: 'unknown-site' });
          return;
        }

        const createdTab = await chrome.tabs.create({ url: targetUrl });
        sendResponse({ ok: true, created: true, tabId: createdTab?.id || null });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (message?.type !== 'INSERT_PROMPT') return false;

  (async () => {
    try {
      let targetTab = null;
      if (message.site) {
        targetTab = await findLastFocusedTabForSite(message.site);
        if (!targetTab?.id) {
          sendResponse({ ok: false, error: 'site-tab-not-found', site: message.site });
          return;
        }
      }

      if (!targetTab?.id) {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        targetTab = activeTab || null;
      }

      if (!targetTab?.id) {
        sendResponse({ ok: false, error: 'no-active-tab' });
        return;
      }

      if (message.site) {
        const expectedOrigin = AI_ORIGINS[message.site];
        const targetOrigin = getOrigin(targetTab.url);
        const expected = getOrigin(expectedOrigin);
        if (expected && targetOrigin && targetOrigin !== expected) {
          sendResponse({ ok: false, error: 'site-tab-not-found', site: message.site });
          return;
        }
      }

      const response = await chrome.tabs.sendMessage(targetTab.id, {
        type: 'STRATEGY_KIT_INSERT',
        text: message.text,
        site: message.site || null,
      });
      // content script が { ok, error } を返す前提。非オブジェクト応答はフォールバック。
      sendResponse(response && typeof response === 'object' ? response : { ok: !!response });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true; // async response
});
