# English language pack (draft)

Project Hub runs in Japanese. This optional pack shows the app in English. Texts without a translation stay in Japanese.

Install: unzip the pack, then in the app open [Settings] → "Language pack" → [Add language pack…], choose this folder, select English as the display language, and save.

Files: `ui.json` (screens), `backend.json` (messages from the app and to the AIs), `native.json` (Mac app window). Keys are the Japanese source text; values are the English text. Keep `${0}` placeholders, HTML tags, line breaks and Markdown marks as they are.

This is a draft made with AI for version 4.125.2 (`verifiedWith`). Corrections are welcome as Pull Requests — see CONTRIBUTING.md, section "言語パック". The glossary is in `docs/GLOSSARY.md`.

Check before sending: `HUB_I18N_STRICT=1 node hub/test/run.cjs langpacks/en/test/*.test.js`
