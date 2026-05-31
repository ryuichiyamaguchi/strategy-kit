import { getAuthToken } from '../phase0/auth.js';
import {
  buildProxyToken,
  checkGeminiProxyStatus,
  createBoundGeminiProxy,
  setupGeminiProxyKey,
} from '../phase0/apps-script-client.js';
import { createDocument, batchUpdate, getDocument } from '../phase0/docs-client.js';
import {
  DEEPSEEK_API_KEY_KEY,
  GEMINI_API_KEY_KEY,
  GEMINI_PROXY_KEY,
  GEMINI_PROXY_TOKEN_KEY,
  PROVIDER_TYPE_KEY,
  generateContent,
  getDeepSeekApiKey,
  getGeminiApiKey,
  getSelectedProvider,
} from '../phase0/gemini-client.js';
import {
  createMasterDocument,
  getStoredMasterDocInfo,
  setMasterDocFromUrl,
} from '../phase0/master-doc-manager.js';

async function loadJson(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  return res.json();
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
  } catch (_) {
    /* manifest 取得失敗時は表示しない */
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
    await chrome.storage.sync.set({
      industry: sel.value,
      industryLabel: document.getElementById('industry-label').value,
      storeName: document.getElementById('store-name').value,
      showSafetyNotice: document.getElementById('show-safety').checked,
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
      setStatus(status, result.title || '保存しました', 'ok');
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });

  document.getElementById('master-doc-create')?.addEventListener('click', async () => {
    const status = document.getElementById('master-doc-status');
    setStatus(status, '作成中…');
    try {
      const prompts = await loadJson('data/prompts.json');
      const result = await createMasterDocument({
        docsClient: { createDocument, batchUpdate },
        storageArea: chrome.storage.sync,
        phases: prompts.phases || [],
        industryLabel: document.getElementById('industry-label').value,
        storeName: document.getElementById('store-name').value,
      });
      document.getElementById('master-doc-url').value = result.masterDocUrl;
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

function applyProviderVisibility(provider) {
  const isDeepSeek = provider === 'deepseek';
  const deepseekBlock = document.getElementById('deepseek-settings-block');
  const geminiDirect = document.getElementById('gemini-direct-block');
  const geminiSecure = document.getElementById('gemini-secure-block');
  if (deepseekBlock) deepseekBlock.hidden = !isDeepSeek;
  if (geminiDirect) geminiDirect.hidden = isDeepSeek;
  if (geminiSecure) geminiSecure.hidden = isDeepSeek;
}

async function bindProviderCard() {
  const select = document.getElementById('provider-select');
  const provider = await getSelectedProvider({
    storage: chrome.storage.local,
    syncStorage: chrome.storage.sync,
  });
  if (select) select.value = provider;
  applyProviderVisibility(provider);

  const deepseekKey = await getDeepSeekApiKey({ storage: chrome.storage.local });
  setStatus(
    document.getElementById('deepseek-status'),
    deepseekKey ? 'DeepSeek key 保存済み' : 'DeepSeek key 未保存',
    deepseekKey ? 'ok' : 'warn'
  );

  select?.addEventListener('change', async () => {
    const value = select.value === 'deepseek' ? 'deepseek' : 'gemini';
    applyProviderVisibility(value);
    await chrome.storage.sync.set({ [PROVIDER_TYPE_KEY]: value });
  });

  document.getElementById('deepseek-key-save')?.addEventListener('click', async () => {
    const status = document.getElementById('deepseek-status');
    const input = document.getElementById('deepseek-api-key');
    const key = input.value.trim();
    if (!key) {
      setStatus(status, 'DeepSeek API key を入力してください', 'warn');
      return;
    }
    await chrome.storage.local.set({ [DEEPSEEK_API_KEY_KEY]: key });
    input.value = '';
    setStatus(status, '保存済み', 'ok');
  });

  document.getElementById('deepseek-key-delete')?.addEventListener('click', async () => {
    await chrome.storage.local.remove([DEEPSEEK_API_KEY_KEY]);
    setStatus(document.getElementById('deepseek-status'), '削除しました', 'ok');
  });

  document.getElementById('deepseek-probe')?.addEventListener('click', async () => {
    const status = document.getElementById('deepseek-status');
    setStatus(status, '実行確認中…');
    try {
      const result = await generateContent({
        prompt: 'Reply with exactly: STRATEGY-KIT OK',
        temperature: 0,
      }, {
        storage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      });
      setStatus(status, result.text ? '実行OK' : '応答なし', result.text ? 'ok' : 'warn');
    } catch (error) {
      setStatus(status, getErrorMessage(error), 'ng');
    }
  });
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
  await initVersionLabel();
  await loadBusinessSettings();
  bindOAuthCard();
  bindMasterDocCard();
  await bindProviderCard();
  bindGeminiCard();
  await refreshOAuthStatus({ interactive: false });
  await refreshMasterStatus();
  await refreshGeminiStatus();
}

init().catch((error) => {
  console.error('[STRATEGY-KIT] options init failed:', error);
});
