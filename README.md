# STRATEGY-KIT Helper

マーケティング戦略立案を 10 フェーズで進める教材用 Chrome 拡張機能です。対応する AI チャット画面へユーザー操作でプロンプトを挿入し、Google ドキュメントへ章別に記録します。

## 構成

| パス | 内容 |
|---|---|
| `extension/` | Chrome 拡張本体（ソース） |
| `strategy-kit-v0.12.39.zip` | STRATEGY-KIT 配布版（マーケ戦略立案） |
| `x-kit-v0.12.40.zip` | X-KIT 配布版（X / 旧Twitter アカウント運用） |
| `instagram-kit-v0.12.40.zip` | INSTAGRAM-KIT 配布版（Instagram アカウント運用） |
| `apps-script/` | Google Apps Script（ライブラリ / shim） |
| `docs/` | セットアップガイド・構成図 |
| `setup/` | 配布ハブページ・完全版ガイド・マスター雛形 |

## インストール（受講者向け）

1. お使いの製品の ZIP（`strategy-kit-v0.12.39.zip` / `x-kit-v0.12.40.zip` / `instagram-kit-v0.12.40.zip`）をダウンロードして**解凍**します。
2. Chrome で `chrome://extensions` を開き、右上の「**デベロッパーモード**」を ON にします。
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリックし、解凍したフォルダを選択します。
4. テストユーザー登録済みの Google アカウントでログインし、拡張の設定画面で「Google 連携」を行うと使えます。
   （連携の同意は約7日で切れます。「未連携」と表示されたら、もう一度「Google 連携」を押してください。）

## X-KIT / INSTAGRAM-KIT について

X（旧Twitter）運用の **X-KIT** と Instagram 運用の **INSTAGRAM-KIT** は、STRATEGY-KIT と同じ手順でセットアップできる別製品の拡張機能です。フェーズの中身が各 SNS のアカウント運用計画（§0 プラットフォーム調査 〜 §9 PDCA）になります。

- 直リンク: `https://github.com/ryuichiyamaguchi/strategy-kit/raw/main/x-kit-v0.12.40.zip`
- 直リンク: `https://github.com/ryuichiyamaguchi/strategy-kit/raw/main/instagram-kit-v0.12.40.zip`

## セットアップ

- まずは `setup/strategy-kit-hub.html` を開くと、必要な手順が順番にまとまっています。
- **詳細な手順（Google 連携・マスター作成・§0 開始まで）**: `setup/setup-guide-v0.12.html`
- **Gemini API キーの用意**: `setup/gemini-api-guide-v0.11.html`
- **マスター雛形**: `setup/master-template/`

## 使い方の概要

1. 「事業設定」で業種・店舗名を入力
2. 全自動／半自動で §0〜§9 を生成（財務章は自動でユニットエコノミクスを試算）
3. 生成結果はマスターの Google ドキュメントに章番号順で記録されます

## 補足

- 各受講者がそれぞれ自分の Gemini API キーと Google Apps Script を用意して使う設計です。
- 本拡張は職業訓練校の受講者向け教材として配布しています。

## バージョン

現在の配布版: **STRATEGY-KIT v0.12.39** / **X-KIT v0.12.40** / **INSTAGRAM-KIT v0.12.40**
