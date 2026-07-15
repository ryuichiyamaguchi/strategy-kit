# STRATEGY-KIT Helper（Chrome拡張）

複数AI（Claude / ChatGPT / Gemini / Manus / Genspark / Perplexity / NotebookLM）を横断してマーケ戦略を立案するための、プロンプト挿入支援拡張機能。

## ディレクトリ構成

```
extension/
├── manifest.json
├── background.js          # service worker
├── content/               # 各AIサイト用 content script
│   ├── claude.js
│   ├── chatgpt.js
│   ├── gemini.js
│   ├── manus.js
│   ├── genspark.js
│   ├── perplexity.js
│   ├── notebooklm.js
│   ├── task-monitor.js    # AI画面左下のタスク実況（全体進捗は表示しない）
│   └── google-docs.js
├── lib/
│   └── insert-helpers.js  # 共通ヘルパー（textarea/contenteditable挿入）
├── sidepanel/             # サイドパネルUI（フェーズナビ）
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js
├── options/               # 設定画面
│   ├── options.html
│   ├── options.css
│   └── options.js
├── data/                  # 拡張内蔵データ
│   ├── prompts.json       # フェーズ0〜9 プロンプトパック
│   └── industries.json    # 業種プリセット
├── icons/                 # （正式リリース前にPNG配置）
└── _locales/ja/messages.json
```

## インストール（開発者モード）

1. `chrome://extensions/` を開く
2. 右上「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ 本ディレクトリ（`extension/`）を選択
4. ツールバーに STRATEGY-KIT が表示されればOK
5. ピン留め推奨

## 使い方

1. ツールバーのSTRATEGY-KITアイコン → サイドパネル展開
2. **業種プリセット** を選択（または自由入力）／**店舗・屋号** を入力
3. 下部の **戦略 / リサーチ / 成果物** から作業場所を選択
4. 戦略内で「自分で進める」または「全自動を管理」を選択
5. 第1推奨AIの「タブを開く」または既存タブをアクティブに
6. プロンプト一覧の「挿入」ボタン → 入力欄に自動挿入
7. 手動時は **★部分を埋めて送信**。全自動時はAI画面左下のタスク実況で現在処理を確認

## 設計思想

- ToS遵守: プロンプト挿入のみ。自動fetch/送信/Cookie持出なし
- Day6原則: マスタードキュメント直書き禁止、人間が選別して転記
- 失敗フォールバック: 入力欄が見つからなければクリップボードへコピー

## 権限

- `sidePanel` — サイドパネルUI
- `storage` — 業種・店舗等の設定保存
- `tabs` — 対象AIタブの検出・フォーカス・content scriptへのメッセージング
- `clipboardWrite` — フォールバック用クリップボードコピー
- `host_permissions` — 各AIサイト＋docs.google.com（content scriptを動かすため）

## 開発時の検証

```bash
# JSON構文
python3 -c "import json; [json.load(open(f)) for f in ['manifest.json','data/prompts.json','data/industries.json','_locales/ja/messages.json']]"

# JS構文
node --check background.js
node --check lib/insert-helpers.js
node --check sidepanel/sidepanel.js
node --check options/options.js
for f in content/*.js; do node --check "$f"; done
```

## 既知の制約

- 各AIサイトのDOM変更で content script のセレクタが古くなる可能性（年数回想定）
- Google Docs はiframe＋canvas構造のため、本文への直接挿入はせずクリップボード経由
- icons は未配置（manifest から外してある）。正式リリース時に追加

## バージョン

v0.12.28（2026-07-15 更新）
