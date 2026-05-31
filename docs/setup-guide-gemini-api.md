# Gemini API キー セットアップガイド（strategy-kit フェーズ実行の安定化）

**目的**：strategy-kit v0.10 の Phase 0〜9 を、GAS から Gemini API 直叩きで安定実行できるようにする。
**所要時間**：約10分（初回のみ）
**コスト**：無料枠で運用可能（毎日リセットされる日次クォータの範囲なら課金なし）

---

## このガイドのスコープ

**できること**：
- strategy-kit の Phase 0〜9 プロンプトを GAS 経由で Gemini API に投げて自動実行
- Gemini ブラウザ UI のレート制限とは独立した「自分専用クォータ」で動かす
- マスタードキュメントの分析・要約・構成案生成を Gemini に代行させる

**できないこと（重要）**：
- **NotebookLM Studio スライドデック生成** の制限回避（NotebookLM は外部 API なし）
- **Audio Overview** の生成や API 経由でのアクセス
- **引用ソース照合**（NotebookLM 内蔵機能）

NotebookLM 内部でも Gemini が動いていますが、それは Google 独自プロダクトとして閉じた機能なので、Gemini API キーを持っていても NotebookLM 側の制限はそのまま残ります。

NotebookLM Studio 生成自体の制限を回避したい場合は、**Day10 以降に案内予定の「Slides API ＋ Gemini API ルート」**（編集可能な Google Slides を直接生成する代替ルート）を待ってください。

---

## なぜ API キーを使うのか（このガイドの範囲で）

Gemini ブラウザ UI には無料枠のリクエスト数・レート制限があり、strategy-kit のフェーズを連続して回すと途中で詰まることがあります。

API キーで直接呼び出すルートに切り替えると、**自分専用のクォータ**を持てます：
- ブラウザ UI とは別の枠（毎日太平洋時間 0時 にリセット）
- 課金設定不要のまま使える
- strategy-kit の各プロンプトを自動連鎖で回せる

---

## STEP 1: Google AI Studio で API キーを取得（5分）

### 1-1. Google AI Studio を開く
- ブラウザで以下にアクセス（**Google アカウントでログイン**）
- https://aistudio.google.com/app/apikey

### 1-2. 「Create API key」をクリック
- 既存の Google Cloud プロジェクトを選ぶか、新規プロジェクトを作る（新規でOK）
- 数秒で API キーが生成される（`AIza...` で始まる文字列）

### 1-3. キーをコピーして安全な場所に保存
- パスワードマネージャー or 自分だけのメモ帳に保存
- **このキーは絶対に他人に見せない・SNS や GitHub に貼らない**
- 万一漏れたら同じページから「削除」して新規生成し直す

---

## STEP 2: Apps Script のスクリプトプロパティに登録（3分）

strategy-kit の Apps Script プロジェクトを開いている前提。

### 2-1. Apps Script のプロジェクト設定を開く
- 左サイドバーの **歯車アイコン（プロジェクトの設定）** をクリック

### 2-2. 「スクリプト プロパティ」セクションまでスクロール
- 「スクリプト プロパティを追加」ボタンをクリック

### 2-3. 以下のプロパティを追加
| プロパティ名 | 値 |
|---|---|
| `GEMINI_API_KEY` | STEP 1 でコピーした API キー（`AIza...`） |

- 「**スクリプト プロパティを保存**」をクリック

---

## STEP 3: 動作確認（2分）

### 3-1. Apps Script エディタで関数 `diagnoseSetup` を実行
- エディタ上部の関数選択ドロップダウンから `diagnoseSetup` を選択
- ▶ 実行ボタンを押す

### 3-2. 実行ログを確認
- 下部に「実行ログ」が表示される
- `GEMINI_API_KEY: 設定済み` のような表示があれば成功
- もし `[ERROR] GEMINI_API_KEY がスクリプトプロパティに未設定です。` と出たら STEP 2 をやり直す

### 3-3. Chrome 拡張から呼び出してみる
- strategy-kit の Chrome 拡張サイドパネルを開く
- Phase 0 など任意のフェーズの「Gemini で実行」ボタン（あれば）を押してみる
- 結果が返ってくれば動作OK

---

## 無料枠の運用ルール

### クォータの考え方
- **毎日（太平洋時間0時）にリセット**される
- 1回使ったら終わり、ではない
- モデルごとに上限が違う：
  - **Gemini 2.5 Flash**：無料枠の毎日リクエスト数（RPD）上限が緩め。日常使いはこれで十分
  - **Gemini 2.5 Pro**：高品質だが RPD は厳しめ。重要な分析だけに使う
  - **Gemini 2.5 Flash-Lite**：最も緩い。試行錯誤や下書き用

### 制限に当たったら
1. 数時間〜翌日まで待つ（太平洋時間0時でリセット）
2. モデルを Flash-Lite に切り替える（クォータが別枠）
3. 講師（山口さん）の救済窓口に依頼

### 課金される条件
- 無料枠を超えても、**スクリプトプロパティに billing 設定をしていなければ課金されない**（リクエストが拒否されるだけ）
- 「気づかないうちに課金される」心配はない

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `[ERROR] GEMINI_API_KEY が未指定です` | スクリプトプロパティに `GEMINI_API_KEY` を追加（STEP 2 を再確認） |
| `403 Forbidden` | API キーが無効化されている → AI Studio で新規生成して再登録 |
| `429 Too Many Requests` | 無料枠の RPM/RPD に到達 → 数分〜翌日待つ、または Flash-Lite に切り替え |
| `503 Service Unavailable` | Google 側の一時的な過負荷 → 数分後に再試行 |
| Chrome 拡張から呼んでも反応しない | GAS Web App の URL が拡張側の設定に登録されているか確認 |

---

## セキュリティ上の注意

- API キーは **Apps Script のスクリプトプロパティ（暗号化保存）** にだけ入れる
- ソースコード本文にハードコーディングしない
- GAS プロジェクトを他人と共有するときは、共有相手のキーを別個に登録してもらう（自分のキーは渡さない）
- 万一キーが漏洩したら、AI Studio の API キーページから即削除 → 新規生成

---

## 参考リンク

- Google AI Studio：https://aistudio.google.com/app/apikey
- Gemini API レート制限ドキュメント：https://ai.google.dev/gemini-api/docs/rate-limits
- strategy-kit v0.10 README：`../README.md`
- strategy-kit v0.10 引き継ぎノート：`../HANDOFF_2026-05-01_v0.10.0.md`
