import { getAuthToken } from '../phase0/auth.js';
import {
  buildProxyToken,
  checkGeminiProxyStatus,
  createBoundGeminiProxy,
  setupGeminiProxyKey,
} from '../phase0/apps-script-client.js';
import { createDocument, batchUpdate, getDocument } from '../phase0/docs-client.js';
import {
  GEMINI_API_KEY_KEY,
  GEMINI_PROXY_KEY,
  GEMINI_PROXY_TOKEN_KEY,
  generateContent,
  getGeminiApiKey,
} from '../phase0/gemini-client.js';
import {
  createMasterDocument,
  getStoredMasterDocInfo,
  setMasterDocFromUrl,
} from '../phase0/master-doc-manager.js';
import { patchActiveProjectWorkspace } from '../phase0/project-workspace.js';

const LATEST_RELEASE_URL = 'https://github.com/ryuichiyamaguchi/strategy-kit/releases/latest';

async function loadJson(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  return res.json();
}

// product.json を読んで製品設定を解決する（sidepanel.js の resolveProductConfig と同一挙動）。
// loadJson を注入式にして外部依存のない純関数に保つ。product.json が無い・壊れている
// 場合は現行ハードコードパス（Webマーケ版）へ完全フォールバックする。
const PRODUCT_CONFIG_FALLBACK = {
  productLine: 'strategy-kit-v0.11',
  promptsPath: 'data/prompts.json',
  benchmarkSource: 'industry',
  benchmarkPath: 'data/industries.json',
  branding: { name: 'STRATEGY-KIT Helper', footerLabel: 'STRATEGY-KIT' },
};

async function resolveProductConfig(loadJsonFn) {
  let raw = null;
  try {
    raw = await loadJsonFn('product.json');
  } catch (e) {
    raw = null;
  }
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    productLine: cfg.productLine || PRODUCT_CONFIG_FALLBACK.productLine,
    promptsPath: cfg.promptsPath || PRODUCT_CONFIG_FALLBACK.promptsPath,
    benchmarkSource:
      cfg.benchmarkSource === 'platform' ? 'platform' : PRODUCT_CONFIG_FALLBACK.benchmarkSource,
    benchmarkPath: cfg.benchmarkPath || PRODUCT_CONFIG_FALLBACK.benchmarkPath,
    branding: cfg.branding && typeof cfg.branding === 'object'
      ? cfg.branding
      : PRODUCT_CONFIG_FALLBACK.branding,
  };
}

function setStatus(el, text, kind = '') {
  if (!el) return;
  el.textContent = text;
  el.className = kind ? `status ${kind}` : 'status';
}

function getErrorMessage(error) {
  return error?.message || String(error || 'unknown error');
}

function getEngagementModeLabel(mode) {
  if (mode === 'A') return 'クライアントワーク・ヒアリング実施前';
  if (mode === 'B') return 'クライアントワーク・ヒアリング済';
  if (mode === 'C') return '自社事業';
  return '未選択（サイドパネル冒頭で選択）';
}

async function getGeminiProxyState() {
  const [syncStored, localStored] = await Promise.all([
    chrome.storage.sync.get([GEMINI_PROXY_KEY]),
    chrome.storage.local.get([GEMINI_PROXY_TOKEN_KEY]),
  ]);
  return {
    proxy: syncStored?.[GEMINI_PROXY_KEY] || null,
    token: String(localStored?.[GEMINI_PROXY_TOKEN_KEY] || '').trim(),
  };
}

async function initVersionLabel() {
  try {
    const manifestVersion = chrome?.runtime?.getManifest?.()?.version;
    if (!manifestVersion) return;
    const aboutEl = document.getElementById('about-version');
    if (aboutEl) aboutEl.textContent = 'v' + manifestVersion;
    const updateEl = document.getElementById('update-version-readout');
    if (updateEl) updateEl.textContent = '現在のバージョン: v' + manifestVersion;
  } catch (_) {
    /* manifest 取得失敗時は表示しない */
  }
}

function bindUpdateCard() {
  document.getElementById('open-latest-release')?.addEventListener('click', () => {
    chrome.tabs.create({ url: LATEST_RELEASE_URL });
  });
}

// 見出し・タイトル・概要文を product.json の branding に間接化する。
// 各キー欠落・product.json 未読時は STRATEGY-KIT の現状文言を維持する（既存挙動を一切変えない）。
async function initBranding() {
  try {
    const config = await resolveProductConfig(loadJson);
    const branding = (config && config.branding) || {};
    const name = branding.name || 'STRATEGY-KIT';
    // audienceContext は「〜講座の受講者」想定なので「〜の受講者を主な対象とした」の形で文に馴染ませる。
    // 欠落時は現状 STRATEGY-KIT の固定文言へフォールバックする（既存挙動を変えない）。
    const audienceContext = branding.audienceContext || '';
    const purposeLabel = branding.purposeLabel || 'マーケ戦略立案';

    document.title = name + ' 設定';
    const titleEl = document.getElementById('options-title');
    if (titleEl) titleEl.textContent = name;
    const aboutTool = document.getElementById('about-tool');
    if (aboutTool) {
      const audienceClause = audienceContext
        ? audienceContext + 'を主な対象とした修了記念配布物'
        : '職業訓練マーケティング戦略講座の修了記念配布物';
      aboutTool.textContent =
        name + ' は、' + audienceClause + 'です。' +
        'マスタードキュメント中心の' + purposeLabel + 'を、複数AI横断で支援します。';
    }
  } catch (_) {
    /* branding 解決失敗時は HTML の現状文言のまま */
  }
}

function bindBackButtons() {
  function handleBack() {
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab && tab.id) {
          chrome.tabs.remove(tab.id);
        } else {
          window.close();
        }
      });
    } catch (e) {
      window.close();
    }
  }
  document.getElementById('back-btn')?.addEventListener('click', handleBack);
  document.getElementById('back-btn-bottom')?.addEventListener('click', handleBack);
}

async function loadBusinessSettings() {
  const industries = await loadJson('data/industries.json');
  const stored = await chrome.storage.sync.get([
    'industry',
    'industryLabel',
	    'storeName',
	    'showSafetyNotice',
	    'sk_engagement_mode',
	  ]);

  const sel = document.getElementById('industry');
  for (const item of industries.items || []) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    if (item.id === stored.industry) option.selected = true;
    sel.appendChild(option);
  }

	  document.getElementById('industry-label').value = stored.industryLabel || '';
	  document.getElementById('store-name').value = stored.storeName || '';
	  document.getElementById('show-safety').checked = stored.showSafetyNotice !== false;
	  const modeReadout = document.getElementById('engagement-mode-readout');
	  if (modeReadout) {
	    modeReadout.textContent = getEngagementModeLabel(stored.sk_engagement_mode);
	  }

  document.getElementById('save').addEventListener('click', async () => {
    const businessPatch = {
      industry: sel.value,
      industryLabel: document.getElementById('industry-label').value,
      storeName: document.getElementById('store-name').value,
      showSafetyNotice: document.getElementById('show-safety').checked,
    };
    await chrome.storage.sync.set(businessPatch);
    await patchActiveProjectWorkspace({
      patch: businessPatch,
      localStorage: chrome.storage.local,
      syncStorage: chrome.storage.sync,
    });
    const msg = document.getElementById('saved-msg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2200);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (changes.industry && changes.industry.newValue) {
      sel.value = changes.industry.newValue;
    }
    if (changes.industryLabel) {
      document.getElementById('industry-label').value = changes.industryLabel.newValue || '';
    }
    if (changes.storeName) {
      document.getElementById('store-name').value = changes.storeName.newValue || '';
    }
    if (changes.sk_engagement_mode) {
      const modeReadout = document.getElementById('engagement-mode-readout');
      if (modeReadout) modeReadout.textContent = getEngagementModeLabel(changes.sk_engagement_mode.newValue);
    }
  });
}

async function applyImportedBusinessInfo(businessInfo) {
  const industryLabel = String(businessInfo?.industryLabel || '').trim();
  const storeName = String(businessInfo?.storeName || '').trim();
  if (!industryLabel && !storeName) return false;
  const patch = {};
  if (industryLabel) patch.industryLabel = industryLabel;
  if (storeName) patch.storeName = storeName;
  await chrome.storage.sync.set(patch);
  await patchActiveProjectWorkspace({
    patch,
    localStorage: chrome.storage.local,
    syncStorage: chrome.storage.sync,
  });
  if (industryLabel) document.getElementById('industry-label').value = industryLabel;
  if (storeName) document.getElementById('store-name').value = storeName;
  return true;
}

async function refreshOAuthStatus({ interactive = false } = {}) {
  const status = document.getElementById('oauth-status');
  setStatus(status, interactive ? '連携中…' : '確認中…');
  try {
    const token = await getAuthToken({ interactive });
    await chrome.storage.sync.set({
      sk_oauth_ready: {
        connected: true,
        checkedAt: new Date().toISOString(),
      },
    });
    setStatus(status, `連携済み (${token.slice(0, 8)}...)`, 'ok');
    return true;
  } catch (error) {
    await chrome.storage.sync.set({
      sk_oauth_ready: {
        connected: false,
        checkedAt: new Date().toISOString(),
        error: getErrorMessage(error),
      },
    });
    setStatus(status, interactive ? '連携できませんでした' : '未連携', interactive ? 'ng' : 'warn');
    return false;
  }
}

function bindOAuthCard() {
  document.getElementById('oauth-connect')?.addEventListener('click', () => {
    refreshOAuthStatus({ interactive: true });
  });
  document.getElementById('oauth-probe')?.addEventListener('click', () => {
    refreshOAuthStatus({ interactive: false });
  });
  document.getElementById('oauth-clear')?.addEventListener('click', async () => {
    const status = document.getElementById('oauth-status');
    setStatus(status, 'cache clear 中…');
    try {
      await new Promise((resolve) => {
        if (chrome.identity.clearAllCachedAuthTokens) {
          chrome.identity.clearAllCachedAuthTokens(() => resolve());
        } else {
          resolve();
        }
      });
      await chrome.storage.sync.remove(['sk_oauth_ready']);
      setStatus(status, 'cache を削除しました', 'ok');
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });
}

async function refreshMasterStatus() {
  const status = document.getElementById('master-doc-status');
  const input = document.getElementById('master-doc-url');
  setStatus(status, '確認中…');
  const result = await getStoredMasterDocInfo({
    docsClient: { getDocument },
    storageArea: chrome.storage.sync,
  });
  if (result.exists) {
    input.value = result.docUrl || '';
    setStatus(status, result.title || '保存済み', 'ok');
    return result;
  }
  setStatus(status, result.error ? '保存済みURLを確認してください' : '未設定', result.error ? 'warn' : '');
  return result;
}

function bindMasterDocCard() {
  document.getElementById('master-doc-verify')?.addEventListener('click', async () => {
    const status = document.getElementById('master-doc-status');
    const url = document.getElementById('master-doc-url').value.trim();
    setStatus(status, '確認中…');
    try {
      const result = await setMasterDocFromUrl(url, {
        docsClient: { getDocument },
        storageArea: chrome.storage.sync,
      });
      await patchActiveProjectWorkspace({
        patch: { sk_master_doc_v012: result.masterInfo },
        localStorage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      });
      const businessApplied = await applyImportedBusinessInfo(result.businessInfo);
      setStatus(
        status,
        businessApplied
          ? `${result.title || '保存しました'} · 事業情報も反映しました`
          : result.title || '保存しました',
        'ok',
      );
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });

  document.getElementById('master-doc-create')?.addEventListener('click', async () => {
    const status = document.getElementById('master-doc-status');
    setStatus(status, '作成中…');
    try {
      // product.json 経由で promptsPath を解決（無ければ data/prompts.json へフォールバック）
      const productConfig = await resolveProductConfig(loadJson);
      const prompts = await loadJson(productConfig.promptsPath);
      const result = await createMasterDocument({
        docsClient: { createDocument, batchUpdate },
        storageArea: chrome.storage.sync,
        phases: prompts.phases || [],
        industryLabel: document.getElementById('industry-label').value,
        storeName: document.getElementById('store-name').value,
      });
      document.getElementById('master-doc-url').value = result.masterDocUrl;
      await patchActiveProjectWorkspace({
        patch: { sk_master_doc_v012: result.masterInfo },
        localStorage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      });
      setStatus(status, result.title || '作成しました', 'ok');
      chrome.tabs.create({ url: result.masterDocUrl });
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });

  document.getElementById('open-master-doc')?.addEventListener('click', async () => {
    const status = document.getElementById('master-doc-status');
    const result = await refreshMasterStatus();
    if (result.exists && result.docUrl) {
      chrome.tabs.create({ url: result.docUrl });
    } else {
      setStatus(status, '先にURL確認または新規作成をしてください', 'warn');
    }
  });
}

async function refreshGeminiStatus() {
  const status = document.getElementById('gemini-status');
  const proxyStatus = document.getElementById('gemini-proxy-status');
  const proxyOpen = document.getElementById('gemini-proxy-open');
  const proxyImageModeNotice = document.getElementById('proxy-image-mode-notice');
  const key = await getGeminiApiKey({ storage: chrome.storage.local });
  setStatus(status, key ? '直接 key 保存済み' : '直接 key 未保存', key ? 'ok' : 'warn');

  const { proxy, token } = await getGeminiProxyState();
  if (proxyOpen) proxyOpen.disabled = !(proxy?.scriptUrl || proxy?.scriptId);
  if (!proxy) {
    if (proxyImageModeNotice) {
      proxyImageModeNotice.textContent = '画像系図解をセキュア学習モードで使うには、画像生成対応のproxyを新規作成してください。直接 API key モードでも利用できます。';
    }
    setStatus(proxyStatus, 'proxy 未作成', 'warn');
    return;
  }
  if (proxyImageModeNotice) {
    const createdAt = proxy.createdAt ? new Date(proxy.createdAt).getTime() : 0;
    const imageReadyCutoff = new Date('2026-05-26T00:00:00+09:00').getTime();
    proxyImageModeNotice.textContent = createdAt && createdAt >= imageReadyCutoff
      ? 'このproxyは画像生成対応のproxyテンプレートで作成されています。図解タブで画像系図解を選べます。'
      : '画像系図解をproxyで使う場合は、画像生成対応のproxyとして再作成してください。既存proxyはテキスト生成には使えます。';
  }
  if (!token) {
    setStatus(proxyStatus, 'proxy token が未保存です。再作成してください', 'warn');
    return;
  }
  if (!proxy.webAppUrl) {
    setStatus(proxyStatus, 'script 作成済み。Web app URL を確認してください', 'warn');
    return;
  }
  setStatus(proxyStatus, 'proxy 作成済み', 'ok');
}

function bindGeminiCard() {
  const ack = document.getElementById('gemini-local-key-ack');
  const saveBtn = document.getElementById('gemini-key-save');
  const syncLocalSaveState = () => {
    if (saveBtn) saveBtn.disabled = !ack?.checked;
  };
  ack?.addEventListener('change', syncLocalSaveState);
  syncLocalSaveState();

  document.getElementById('gemini-key-save')?.addEventListener('click', async () => {
    const status = document.getElementById('gemini-status');
    const input = document.getElementById('gemini-api-key');
    if (!ack?.checked) {
      setStatus(status, '注意事項を確認してチェックしてください', 'warn');
      return;
    }
    const key = input.value.trim();
    if (!key) {
      setStatus(status, 'API key を入力してください', 'warn');
      return;
    }
    await chrome.storage.local.set({ [GEMINI_API_KEY_KEY]: key });
    input.value = '';
    setStatus(status, '保存済み', 'ok');
  });

  document.getElementById('gemini-key-delete')?.addEventListener('click', async () => {
    await chrome.storage.local.remove([GEMINI_API_KEY_KEY]);
    setStatus(document.getElementById('gemini-status'), '削除しました', 'ok');
  });

  document.getElementById('gemini-probe')?.addEventListener('click', async () => {
    const status = document.getElementById('gemini-status');
    setStatus(status, '実行確認中…');
    try {
      const result = await generateContent({
        prompt: 'Reply with exactly: STRATEGY-KIT OK',
        temperature: 0,
      }, {
        storage: chrome.storage.local,
        syncStorage: null,
      });
      setStatus(status, result.text ? '実行OK' : '応答なし', result.text ? 'ok' : 'warn');
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });

  document.getElementById('gemini-proxy-create')?.addEventListener('click', async () => {
    const status = document.getElementById('gemini-proxy-status');
    setStatus(status, 'proxy 作成中…');
    try {
      const master = await refreshMasterStatus();
      if (!master.exists || !master.documentId) {
        setStatus(status, '先にマスタードキュメントを作成または確認してください', 'warn');
        return;
      }
      const proxyToken = buildProxyToken();
      const result = await createBoundGeminiProxy({
        masterDocId: master.documentId,
        title: `Strategy Kit Gemini Proxy - ${master.title || master.documentId}`,
        proxyToken,
      });
      await chrome.storage.sync.set({ [GEMINI_PROXY_KEY]: result });
      await chrome.storage.local.set({ [GEMINI_PROXY_TOKEN_KEY]: proxyToken });
      setStatus(status, result.webAppUrl ? 'proxy 作成済み' : 'script 作成済み。デプロイを確認してください', result.webAppUrl ? 'ok' : 'warn');
      if (result.scriptUrl) chrome.tabs.create({ url: result.scriptUrl });
      await refreshGeminiStatus();
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });

  document.getElementById('gemini-proxy-open')?.addEventListener('click', async () => {
    const status = document.getElementById('gemini-proxy-status');
    const { proxy } = await getGeminiProxyState();
    const url = proxy?.scriptUrl || (proxy?.scriptId ? `https://script.google.com/d/${proxy.scriptId}/edit` : '');
    if (!url) {
      setStatus(status, 'proxy を先に作成してください', 'warn');
      return;
    }
    chrome.tabs.create({ url });
  });

  document.getElementById('gemini-proxy-clear')?.addEventListener('click', async () => {
    await Promise.all([
      chrome.storage.sync.remove([GEMINI_PROXY_KEY]),
      chrome.storage.local.remove([GEMINI_PROXY_TOKEN_KEY]),
    ]);
    setStatus(document.getElementById('gemini-proxy-status'), '拡張側の proxy 設定を削除しました', 'ok');
    await refreshGeminiStatus();
  });

  document.getElementById('gemini-proxy-setup-key')?.addEventListener('click', async () => {
    const status = document.getElementById('gemini-proxy-status');
    const input = document.getElementById('gemini-proxy-api-key');
    const apiKey = input.value.trim();
    input.value = '';
    input.removeAttribute('value');
    input.blur();
    if (!apiKey) {
      setStatus(status, 'API key を入力してください', 'warn');
      return;
    }
    const { proxy, token } = await getGeminiProxyState();
    if (!proxy?.webAppUrl || !token) {
      setStatus(status, '先に proxy を作成してください', 'warn');
      return;
    }
    setStatus(status, 'proxy に key 設定中…');
    try {
      await setupGeminiProxyKey({
        webAppUrl: proxy.webAppUrl,
        proxyToken: token,
        apiKey,
      });
      setStatus(status, 'Apps Script に key 設定済み', 'ok');
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });

  document.getElementById('gemini-proxy-test')?.addEventListener('click', async () => {
    const status = document.getElementById('gemini-proxy-status');
    const { proxy, token } = await getGeminiProxyState();
    if (!proxy?.webAppUrl || !token) {
      setStatus(status, '先に proxy を作成してください', 'warn');
      return;
    }
    setStatus(status, 'proxy 実行確認中…');
    try {
      await checkGeminiProxyStatus({ webAppUrl: proxy.webAppUrl, proxyToken: token });
      const result = await generateContent({
        prompt: 'Reply with exactly: STRATEGY-KIT OK',
        temperature: 0,
      }, {
        storage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      });
      setStatus(status, result.mode === 'proxy' && result.text ? 'proxy 実行OK' : 'proxy 応答なし', result.mode === 'proxy' && result.text ? 'ok' : 'warn');
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });
}

async function init() {
  bindBackButtons();
  bindUpdateCard();
  await initBranding();
  await initVersionLabel();
  await loadBusinessSettings();
  bindOAuthCard();
  bindMasterDocCard();
  bindGeminiCard();
  await refreshOAuthStatus({ interactive: false });
  await refreshMasterStatus();
  await refreshGeminiStatus();
}

init().catch((error) => {
  console.error('[STRATEGY-KIT] options init failed:', error);
});
