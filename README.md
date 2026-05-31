# STRATEGY-KIT Helper

マーケティング戦略立案を 10 フェーズで進める教材用 Chrome 拡張機能です。対応する AI チャット画面へユーザー操作でプロンプトを挿入し、Google ドキュメントへ章別に記録します。

## 構成

| パス | 内容 |
|---|---|
| `extension/` | Chrome 拡張本体（ソース） |
| `strategy-kit-v0.12.16.zip` | そのままインストールできる配布版 |
| `apps-script/` | Google Apps Script（ライブラリ / shim） |
| `docs/` | セットアップガイド・構成図 |
| `setup/` | 配布ハブページ・完全版ガイド・マスター雛形 |

## インストール（受講者向け）

1. `strategy-kit-v0.12.16.zip` をダウンロードして**解凍**します。
2. Chrome で `chrome://extensions` を開き、右上の「**デベロッパーモード**」を ON にします。
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリックし、解凍したフォルダを選択します。
4. テストユーザー登録済みの Google アカウントでログインすると使えます。

## セットアップ

- **AI プロバイダの選択**: 設定画面で Gemini または DeepSeek を選べます（未設定なら Gemini）。
- **Gemini API キーの用意**: `docs/setup-guide-gemini-api.md`
- **詳細な手順（Apps Script のデプロイ・マスター作成など）**: `setup/setup-guide-v0.11.html`
- **マスター雛形**: `setup/master-template/`
- まずは `setup/strategy-kit-hub.html` を開くと、必要な手順が順番にまとまっています。

## 使い方の概要

1. 「事業設定」で業種・店舗名を入力
2. 全自動／半自動で §0〜§9 を生成（財務章は自動でユニットエコノミクスを試算）
3. 生成結果はマスターの Google ドキュメントに章番号順で記録されます

## 補足

- 各受講者がそれぞれ自分の Gemini API キーと Google Apps Script を用意して使う設計です。
- 本拡張は職業訓練校の受講者向け教材として配布しています。

## バージョン

現在の配布版: **v0.12.16**
