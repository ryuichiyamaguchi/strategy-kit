# StrategyKitLib — マスター GAS（ライブラリ版） v0.11.0

このディレクトリは **山口さんが管理する側のマスター Apps Script プロジェクト**です。
受講者には貼らせません。受講者は `../shim/` のファイルを貼るだけで、
ロジック側の更新は `developmentMode: true` で自動反映されます。

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `StrategyKitLib.gs` | ロジック本体（UI ダイアログ・章操作・Web App ルータ・全ハンドラ） |
| `Gemini.gs` | Gemini API 呼出ヘルパ（apiKey 引数化版＋カスタム関数バックエンド） |
| `appsscript.json` | ライブラリ用マニフェスト（webapp 設定なし） |

---

## セットアップ手順（初回のみ）

### 1. 新規 GAS プロジェクト作成

1. <https://script.google.com/home> を開く
2. 「新しいプロジェクト」→ プロジェクト名を `StrategyKitLib` に変更
3. デフォルトの `Code.gs` を削除
4. このディレクトリの `StrategyKitLib.gs` と `Gemini.gs` の中身をそれぞれ新規ファイルとして貼付
5. プロジェクト設定（歯車アイコン）→「`appsscript.json` マニフェスト ファイルをエディタで表示する」を有効化
6. 表示された `appsscript.json` を、このディレクトリの `appsscript.json` の内容で上書き

### 2. ライブラリとしてデプロイ

1. エディタ右上「デプロイ」→「新しいデプロイ」
2. 種類を選択 → 歯車 →「**ライブラリ**」
3. 説明: `StrategyKit v0.11.0 — initial library deploy`
4. デプロイをクリック
5. 表示される **スクリプト ID** を控える（受講者の `shim/appsscript.json` の `libraryId` に埋め込む値）
6. プロジェクトを共有: 共有ボタン → アクセス権を「**リンクを知っている全員（閲覧者）**」に変更
   - これがないと受講者の GAS から `StrategyKitLib` を解決できない

### 3. ライブラリ更新時の運用

- 山口さんがロジックを修正したら、エディタで保存するだけで `developmentMode: true` の受講者には即座に反映される
- 互換性のない変更（破壊的変更）を入れたいときは「新しいデプロイ」でバージョン番号を切る
- 受講者の `shim/appsscript.json` で `version` を固定したい場合は `developmentMode: false` + `version: "1"` 等に変更してもらう

---

## スクリプトプロパティ

ライブラリ側の ScriptProperties は **使わない**。受講者の Properties が `props` として
引数渡しされる設計のため、ライブラリ自身は永続データを持たない。

ただし、ライブラリ側の Apps Script プロジェクトでも一度は `onOpen` 等を実行して
OAuth 同意を済ませる必要はない（ライブラリは呼ばれた側のコンテキストで動くため、
受講者の同意で十分）。

---

## OAuth スコープ

`appsscript.json` で以下を要求：

- `documents` — Doc 編集
- `drive` — Drive ファイル操作
- `script.container.ui` — メニュー・ダイアログ
- `script.external_request` — Gemini API
- `script.scriptapp` — `ScriptApp.getAuthorizationInfo` で権限診断

`spreadsheets` はライブラリ自身では使わない（カスタム関数 `GEMINI` を呼び出すのは
受講者の shim 側で、shim 側で要求される）。

---

## 公開インターフェース（shim から呼ばれる関数）

| 関数 | 説明 |
|---|---|
| `getVersionInfo()` | `{ version, productLine, productVersion, schemaVersion }` を返す |
| `route(e, props)` | Web App リクエストルータ（`doPost` / `doGet` から委譲される） |
| `uiSetupTemplate(props)` | テンプレート登録ダイアログ |
| `uiCreateMaster(presetId, props)` | 業種プリセット指定の新規マスター作成 |
| `uiAppendDecision(props)` | §99 決定ログ追記ダイアログ |
| `uiUpdateTimestamps(props)` | 章末タイムスタンプ更新ダイアログ |
| `uiAppendSectionSummary(props)` | §N 要点版追記ダイアログ |
| `uiShowHelp(props)` | 使い方ダイアログ |
| `geminiCustom(prompt, model, temperature, apiKey)` | シート用 `=GEMINI()` のバックエンド |
| `geminiBatchCustom(range, prefix, model, apiKey)` | シート用 `=GEMINI_BATCH()` のバックエンド |

`props` の必須プロパティ:
- `SK_DOC_ID` / `SK_DRAFT_DOC_ID` / `SK_TEMPLATE_DOC_ID` / `GEMINI_API_KEY`
- `getProperty(key)` / `setProperty(key, value)` メソッド

詳細は `StrategyKitLib.gs` の冒頭コメント参照。

---

## 注意点

- `onOpen` / `doPost` / `doGet` はライブラリで定義しても受講者の GAS で動かない（トリガー仕様）。これらは shim 側で定義する。
- メニュー登録の関数名は **shim 側のグローバル関数名**を文字列で渡すため、shim 側に同名のラッパが必要。
- `DocumentApp.getActiveDocument()` は呼出元コンテキストで動くため、ライブラリ側でそのまま使える（受講者の Doc が active になる）。
- `PropertiesService.getScriptProperties()` をライブラリ内で直接呼ぶと **ライブラリ自身のプロパティ**にアクセスしてしまう（受講者のプロパティでない）。必ず引数の `props` を経由する。
