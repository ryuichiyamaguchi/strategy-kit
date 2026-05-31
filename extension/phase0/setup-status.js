export function buildSetupChecklistItems({
  industryLabel = '',
  storeName = '',
  oauthReady = false,
  oauthError = null,
  masterDoc = null,
  masterError = null,
  geminiKeyPresent = false,
  geminiProxyPresent = false,
} = {}) {
  const hasBusiness = !!(String(industryLabel || '').trim() && String(storeName || '').trim());
  const items = [];

  items.push({
    id: 'business',
    title: '事業情報',
    status: hasBusiness ? 'ok' : 'warn',
    label: hasBusiness ? '入力済み' : '未入力',
    detail: hasBusiness
      ? `業種「${industryLabel}」と店舗「${storeName}」を読み込みました。`
      : '業種と店舗・屋号の両方を入れると、置換とフェーズ開始が揃います。',
    action: hasBusiness ? '' : 'open-setup',
    actionLabel: '入力する',
  });

  items.push({
    id: 'oauth',
    title: 'Google アカウント',
    status: oauthReady ? 'ok' : 'error',
    label: oauthReady ? '連携済み' : '未連携',
    detail: oauthReady
      ? 'Chrome Identity で Google Docs / Drive API を呼び出せます。'
      : buildOAuthDetail(oauthError),
    action: oauthReady ? '' : 'open-options',
    actionLabel: oauthReady ? '' : '連携する',
  });

  const hasMaster = !!(masterDoc && masterDoc.documentId);
  items.push({
    id: 'master-doc',
    title: 'マスタードキュメント',
    status: hasMaster ? 'ok' : 'warn',
    label: hasMaster ? '確認済み' : '未設定',
    detail: hasMaster
      ? `「${masterDoc.title || 'マスタードキュメント'}」を使います。`
      : buildMasterDetail(masterError),
    action: hasMaster ? 'open-master-doc' : 'open-options',
    actionLabel: hasMaster ? '開く' : '設定する',
  });

  const geminiReady = !!(geminiProxyPresent || geminiKeyPresent);
  const geminiLabel = geminiProxyPresent
    ? 'proxy 設定済み'
    : geminiKeyPresent
      ? '直接 key 保存済み'
      : '任意';
  const geminiDetail = geminiProxyPresent
    ? 'セキュア学習モードの Gemini proxy が使えます。拡張機能側に API key を保存せずに全自動生成と図解生成を実行します。'
    : geminiKeyPresent
      ? '直接 key モードで Gemini API を使えます。学習用に上限を絞った key だけを保存してください。'
      : 'Gemini API key がなくても手動AI挿入のチェーンは使えます。全自動生成と図解自動生成を使う場合だけ設定してください。';

  items.push({
    id: 'gemini-key',
    title: 'Gemini API key',
    status: geminiReady ? 'ok' : 'warn',
    label: geminiLabel,
    detail: geminiDetail,
    action: geminiReady ? '' : 'open-options',
    actionLabel: geminiReady ? '' : '設定する',
  });

  return items;
}

export function describeSetupSummary(items = []) {
  const blocking = items.find((item) => item.status === 'error');
  if (blocking) {
    return `まず「${blocking.title}」の ${blocking.label} を解消してください。`;
  }
  const next = items.find((item) => item.status === 'warn');
  if (next) {
    return `次は「${next.title}」の ${next.label} を整えると導入が完了します。`;
  }
  return '初回導入に必要な項目は揃っています。次は §0 から開始できます。';
}

function buildOAuthDetail(error) {
  const message = String(error?.message || error || '');
  if (/network|failed|timeout/i.test(message)) {
    return 'Google アカウント連携の確認で通信に失敗しました。ネットワーク状態を確認して再試行してください。';
  }
  if (/canceled|approve|denied/i.test(message)) {
    return 'Google アカウント連携がキャンセルされました。設定画面から再連携してください。';
  }
  return 'Google アカウント連携が必要です。設定画面で連携してから Docs / Drive 保存を使ってください。';
}

function buildMasterDetail(error) {
  const message = String(error?.message || error || '');
  if (/403|401|permission|forbidden/i.test(message)) {
    return '保存済みのマスタードキュメントにアクセスできません。共有権限または Google 連携を確認してください。';
  }
  if (/404|not found/i.test(message)) {
    return '保存済みのマスタードキュメントが見つかりません。設定画面でURLを確認してください。';
  }
  return '設定画面でマスタードキュメントURLを確認するか、新規作成してください。';
}
