# icons/

**配置済（v0.9.1）** — 2026-04-27 生成・配置完了。

以下4サイズのPNGを配置済み:

- `icon-16.png` (16×16)
- `icon-32.png` (32×32)
- `icon-48.png` (48×48)
- `icon-128.png` (128×128)

配置後、`manifest.json` に以下を追記する:

```json
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
},
"action": {
  "default_title": "STRATEGY-KIT Helper",
  "default_icon": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

## デザイン指針

- ブランドカラー: teal `#0f766e`（マスタードキュメント中心の堅実さ）
- ロゴ: 「SK」モノグラム（白抜き）／角丸8px
- 128px版のみ余白小さめ（Chromeウェブストア表示用）
