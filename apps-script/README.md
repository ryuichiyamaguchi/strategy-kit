# STRATEGY-KIT Apps Script v0.10.0

戦略マスタードキュメント生成・編集を支援する Google Apps Script。
v0.10 で「テンプレート Doc コピー方式（B案）」へ全面切替した版。

---

## v0.10 の主要変更

| 項目 | v0.9.15（旧） | v0.10.0（新） |
|---|---|---|
| マスタードキュメント生成 | コードからゼロ生成（`appendParagraph` 多用） | テンプレート原本を `makeCopy` → `replaceText` で差し替え |
| 章構造の正本 | `Code.gs` 内 `SK_SECTIONS` 定数 | `template_v3.0.md` を Google Docs にインポートしたファイル |
| §-1 案件メタ情報 | 段落形式で動的挿入 | テンプレ既設のテーブルに `replaceText` で値だけ流し込み |
| §N 要点版（500字以内） | なし | 新規（メニュー・Web App API で追記／取得） |
| 業種プリセット | label / businessLine / valueLine | 上記 + `businessType`（B2C地域型 / B2B中小受託 / その他） |

---

## セットアップ手順

### 1. テンプレート原本を Google Docs に取り込む

```
src/master-doc/template_v3.0.md
```

を Google ドライブにアップロードし、Google ドキュメントとして開いて保存する。
（ファイル → ダウンロード で `.gdoc` になる Markdown を Google Docs 形式で開く）

### 2. テンプレート原本を Apps Script に登録

任意の戦略マスタードキュメント（または受講者用の空 Doc）を開き、
拡張機能 → Apps Script に `Code.gs` を貼り付け、保存。

そのドキュメントを再読込すると `STRATEGY-KIT` メニューが現れる。

メニュー → **テンプレート原本セットアップ（初回のみ）** を選択し、
ステップ1で取り込んだテンプレート Doc の URL または ID を入力。
完了するとスクリプトプロパティ `SK_TEMPLATE_DOC_ID` に保存される。

### 3. 新規マスタードキュメントを生成

メニュー → **新規マスタードキュメント作成** → 業種プリセット選択。
店舗名・案件ID・所在地・担当者名を順に入力すると、テンプレートが
コピーされ `{{業種}} {{店舗名}} {{案件ID}} {{所在地}} {{担当者名}} {{YYYY-MM-DD}} {{業種タイプ}}`
が値に差し替わった新 Doc が生成される。

生成された Doc は自動で `SK_DOC_ID` に登録され、以降の操作対象になる。

---

## メニュー一覧（v0.10）

```
STRATEGY-KIT
├ テンプレート原本セットアップ（初回のみ）
├ ─────
├ 新規マスタードキュメント作成
│   ├ クライミングジム
│   ├ 飲食店
│   ├ 美容室・整体院
│   ├ BtoB制作・受託
│   ├ 小売・物販
│   └ 汎用（業種非依存）
├ ─────
├ §99 決定ログに追記
├ 章末タイムスタンプを更新
├ §N 要点版を生成・追記（手動）
├ ─────
└ 使い方（v0.10）
```

---

## Web App エンドポイント（拡張機能との連携API）

### v0.9.15 から維持（後方互換）

| action | 役割 |
|---|---|
| `ping` | 疎通テスト（テンプレ登録状態も返す） |
| `diagnoseSetup` | セットアップ診断（テンプレート原本チェック追加） |
| `getSection` | §N 章本文取得（前章貼付サポート） |
| `getAllSections` | 全章一括取得 |
| `getProgress` | 章別進捗（filled / partial 判定） |
| `saveResearch` | リサーチノートを Drive `research/` に保存 |
| `listResearchFiles` | research/ フォルダのファイル一覧 |
| `appendDecision` | §99 決定ログ追記 |
| `appendMeta` | §-1 案件メタ情報を差し替え（v0.10 から `{{...}}` 差し替え方式） |
| `updateTimestamp` | 章末タイムスタンプ更新 |
| `geminiProxy` | Gemini API プロキシ（モデルフォールバック・リトライ付き） |
| `createDraftDoc` | DRAFT Doc 自動生成 |
| `appendDraftSection` | DRAFT に章追記（AI 出力整形込み） |
| `getDraftInfo` | DRAFT Doc 情報取得 |
| `getDraftProgress` | DRAFT 進捗（§N-M サブ対応） |
| `setDraftDoc` | 既存 DRAFT を URL/ID で切替 |
| `cleanupDraft` | DRAFT を整形して `[CLEAN]` Doc 生成 |
| `generateExecutiveSummary` | DRAFT から `[SUMMARY]` Doc 生成 |
| `setMasterDoc` | 既存マスター Doc を URL/ID で切替 |
| `getMasterDocInfo` | マスター Doc 情報取得 |

### v0.10 新規

| action | 役割 |
|---|---|
| `setupTemplate` | テンプレート原本 Doc ID を登録（拡張機能から） |
| `getTemplateInfo` | テンプレート原本の登録状態取得 |
| `createMasterFromTemplate` | テンプレートから新規マスター生成（業種プリセット指定） |
| `appendSectionSummary` | §N 要点版（500字以内）を該当章末に追記／置換 |
| `getSectionSummary` | §N 要点版テキストを取得（後続フェーズプロンプトに貼付用） |

#### `createMasterFromTemplate` リクエスト例

```json
{
  "action": "createMasterFromTemplate",
  "presetId": "climbing-gym",
  "storeName": "エナジー柏店",
  "caseId": "case-2026-001",
  "location": "千葉県柏市",
  "ownerName": "山口",
  "stakeholders": "山口／田中",
  "monthlyBudget": "30万円/月",
  "businessType": "B2C地域型",
  "periodStart": "2026-05-01",
  "periodEnd": "2026-10-31",
  "setActive": true
}
```

レスポンス:

```json
{
  "ok": true,
  "docId": "...",
  "docUrl": "https://docs.google.com/document/d/.../edit",
  "name": "戦略マスタードキュメント — クライミングジム ／ エナジー柏店",
  "presetId": "climbing-gym",
  "activated": true
}
```

#### `appendSectionSummary` リクエスト例

```json
{
  "action": "appendSectionSummary",
  "sectionNo": "3",
  "summaryText": "勝ち筋: ...（500字以内）",
  "docId": "（省略時は SK_DOC_ID を使用）"
}
```

---

## v0.9.15 との後方互換性

- スクリプトプロパティ `SK_DOC_ID` / `SK_DRAFT_DOC_ID` / `GEMINI_API_KEY` は同じキーを継続利用。
- Web App `action` 名はすべて維持。新規 5 アクションのみ追加。
- `_cleanupAiText_` / `appendDecisionEntry_` / `updateTimestamp_` / `_getSections_` の挙動は同等。
- 章番号正規表現を §-1 などの負番号も拾えるよう緩和（`/^§(-?\d+)\.\s*/`）。
- `_getSections_` で未差し替えプレースホルダ `{{...}}` を含む行は filled 判定から除外。

### 廃止された関数

旧 v0.9.15 から削除した関数:

- `insertTemplate_()` — ゼロ生成ロジック（`appendParagraph` で章を並べる方式）
- `insertTemplateGeneric` / `insertTemplateClimbingGym` / `insertTemplateRestaurant` /
  `insertTemplateBeautySalon` / `insertTemplateBtobCreative` / `insertTemplateRetail` — 旧テンプレ挿入のメニューハンドラ
- `SK_SECTIONS` 定数 — 章構造の正本は template_v3.0.md に移管

これらに依存する拡張機能側のコードがあれば、新規 action `createMasterFromTemplate` への移行が必要。

---

## 関連ファイル

- `src/master-doc/template_v3.0.md` — 章構造の正本（Google Docs に取り込んで使用）
- `src/extension/` — Chrome 拡張機能（Web App API を呼び出す側）

## バージョン

`SK_VERSION = '0.10.0'`
