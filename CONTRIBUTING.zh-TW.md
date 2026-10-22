# 如何參與

[日本語](CONTRIBUTING.md) | 繁體中文

Project Hub 仍在開發中。歡迎分享心得、回報問題或提交 Pull Request。

## 心得與問題回報

- 請使用 Issue 範本：「使用心得與需求」或「問題回報」。
- 不要貼上個人資料、通關密語、token、真實對話或台帳內容。請先遮蔽截圖中的敏感資訊。

## Pull Request

1. 大幅變更或調整畫面設計前，請先在 Issue 討論。
2. 修改 `hub/` 時，請同步更新 `hub/package.json` 的 `version` 與 `hub/CHANGELOG.md` 最上方版本；也請同步繁中變更紀錄 `hub/CHANGELOG.zh-TW.md`。新增功能提高第二碼，修正問題提高第三碼。
3. 確認 `HUB_SKIP_NPM=1 npm --prefix hub test` 通過。
4. 在 PR 說明改了什麼、原因與驗證方式。

## 語言包

畫面的顯示語言以獨立於本體的「語言包」新增。本體只以日文運作；沒有語言包、無法讀取，或沒有譯文的文字，會以日文顯示。

- 位置：`langpacks/<語言ID>/`（例：`langpacks/en/`、`langpacks/zh-TW/`）。語言ID的格式如 `en`、`zh-TW`。
- 必要檔案：`pack.json`（`id`、`name`、`verifiedWith`＝最後確認的本體版本）、`ui.json`（畫面文字）、`backend.json`（`messages`＝本體文字，`labels`＝狀態名稱等）。
- 選用：`native.json`（Mac 應用程式文字）、`README.md`、`docs/`（需要 `README.md` 與 `CHANGELOG.md`）。
- 寫法：鍵是日文原文，值是譯文。請保留 `${0}` 等插入位置、HTML 標籤、換行與 Markdown 標題符號。不接受新增標籤或指令碼。
- 工作檔的標題（成果、手順、やったこと 等）與儲存的狀態名稱由程式讀取，有些地方須保留原文。不確定時請參照現有語言包。

測試方式：

1. 執行 `HUB_I18N_STRICT=1 node hub/test/run.cjs langpacks/<語言ID>/test/*.test.js`，確認沒有未翻譯或格式錯誤（`test/` 請參考現有語言包放置）。
2. 在應用程式的［設定］→「語言包」→［新增語言包…］選擇語言包資料夾，切換顯示語言並確認畫面。

在 Pull Request 中，請寫明新增或修改的語言、筆數、確認的版本（`verifiedWith`）與畫面。只修改譯文時，不需要提高 `hub/package.json` 的版本。

提交的變更將以 MIT 授權公開。
