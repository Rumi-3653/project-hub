# アイデア台帳の実装・検証記録

対象版は4.117.0。受付版を先に実装・検証・保存し、その後に自動継続、固定確認、反映準備を結合した。仕様は最終F0〜F9を優先し、v2 §0〜13を基準とする。実装前の基準は `1153089d24b223b3f13dcabef663a2358c5dc25c`、受付版は `e547449`。独立確認へ渡す最終commit/treeと確認結果は、この作業の台帳に記録する。

現在の方針（4.118.0の画像指摘修正）：通常の自動検査と反映準備は日本語だけを検査し、繁体字の実ファイルを読まない。繁体字は言語パック公開時にまとめる。過去に実施した日繁検査の記録は変更せず、今回の差分・結果は末尾に記録する。

実製品の自動進行は有効にしていない。既存の本番mdを移行せず、稼働中のHub、本体、認証、契約、外部サービスへ操作していない。試験内の自動進行・反映・停止・復元は全て一時Git、別ROOT、偽CLIによるもの。

## 変更範囲

| 範囲 | 主なファイル |
| --- | --- |
| 項目更新、原文、receipt、writer、保存復旧、Git外正本 | `hub/lib/ideas.js`、`idea-utils.js`、`idea-source.js`、`idea-projection.js`、`idea-lifecycle.js` |
| 受付、許可、一覧、質問、予約の操作 | `hub/lib/idea-api.js`、`hub/public/ideas.js`、`ideas.css`、`app.js`、`index.html` |
| 同Gitの開始調停、lane束縛、継続と配送 | `hub/lib/execution-gate.js`、`idea-lane.js`、`idea-runner.js`、`idea-dispatch.js` |
| 実検証、資料固定、限定的な反映準備、固定取り込み | `hub/lib/idea-verification.js`、`idea-review.js`、`idea-release.js`、`idea-frozen-merge.js`、`version-check.js` |
| 既存入口との結合 | `hub/server.js`、`hub/lib/chat.js`、`cli-spool.js`、`safe-file.js`、`sessions.js`、`git.js` |
| 版・文書・公開用出力 | `hub/package.json`、lockfile、日本語・繁体字のREADME/変更履歴、`scripts/export-public.js`、本書、[使い方と復旧](idea-ledger.md) |
| 試験 | `hub/test/idea-*.test.js`、`idea-fixture.cjs`、`version-check.test.js`、関連する既存fixtureと書込監査台帳 |

初期auto-offでも整理の許可はある。作る項目は実装を優先し、失敗停止・人の確認待ちを整理で迂回しない。実装後またはauto-offでは残った整理を行う。pauseは整理も止める。原文改訂は旧受入条件・計画・許可を履歴に保全し、新しい内容へ流用しない。

## 試験結果

初回実装の自己確認は修正後の対象確認を合わせて438件成功、未解決の失敗・skipは0。下表はその時点の集計で、反復は重ねて数えていない。公開用出力はコード保存commit `a16ba0c` から検査した。その後の独立確認と起動処理の修正後の最新結果（新機能82件・関係回帰158件）は後述する。

| 試験群 | 件数 | 結果 |
| --- | ---: | --- |
| 台帳の保存・API/Chrome・継続・配送・確認反映・保管・版 | 81 | 成功（下記の修正後再確認を含む） |
| 通常の会話・queue・統合・履歴・上限 | 246 | 成功 |
| 通常取り込み・保守・更新・起動復旧・書込監査 | 97 | 成功 |
| 統合の同時書き込み | 4 | 成功 |
| commit済みコードの公開用出力 | 10 | 成功（ローカル出力のみ、公開は未実施） |

初回の新機能一括実行は80成功・1失敗だった。画面試験の未確認ラベルの期待を訂正し、台帳revが不変でもGitの変更で旧確認表示を更新し、該当API/Chrome 6件が成功した。コードだけの変更・dirty・以前のlaneの表示も検査した。独立確認では候補 `3725a76` の新機能81件を一括再実行し81/81成功したが、試験外だった起動barrierの共通部に要修正2件が見つかった。

共通部は、検証コマンドの起動直前にleaseを取得する順序を自己確認で改善し、保守/書込監査36件と実HTTP/Chromeを再確認した。この36件は既出97件の内数。過去の失敗はqueue保存同期のexport、停止注入先、公開出力の版検査参照、復旧barrierを待たない旧fixture等で、原因を修正してから該当範囲を再実行した。未解決の失敗はない。

基準環境はmacOS、Nodeの標準test runnerとローカルGit。実ブラウザ2件はインストール済みChromeをheadlessで実行する。`TMPDIR=/private/tmp` はmacOSの一時ディレクトリのsymlinkを避ける試験環境指定で、製品の実体照合を緩めるものではない。

新機能の一括実行（リポジトリ直下）：

```sh
TMPDIR=/private/tmp node --test --test-force-exit hub/test/idea-storage.test.js hub/test/idea-api.test.js hub/test/idea-runner.test.js hub/test/idea-delivery.test.js hub/test/idea-review-release.test.js hub/test/idea-lifecycle.test.js hub/test/version-check.test.js
```

関連回帰の実行対象（同じ `node --test --test-force-exit` で実行）：

```text
hub/test/main-merge-preflight.test.js
hub/test/integration-review-request-http.test.js
hub/test/integration-review-queue.test.js
hub/test/integration-safety.test.js
hub/test/integration-colocated.test.js
hub/test/update-isolation-spool.test.js
hub/test/chat-history.test.js
hub/test/task-history-http.test.js
hub/test/limit-integration.test.js
hub/test/limit-preflight.test.js
hub/test/terminal-limits.test.js
hub/test/queue-edit.test.js
hub/test/app-update-server.test.js
hub/test/main-merge-oneclick.test.js
hub/test/maintenance.test.js
hub/test/update-isolation-restart.test.js
hub/test/integration-write-audit.test.js
hub/test/integration-write-concurrency.test.js
hub/test/public-export.test.js
```

## 独立確認の指摘修正と最新の自己確認

候補 `3725a766dea3f4ae53dde77152c95a2c4fe8105e` は要修正2件のため取り込み可としない。修正コードと追加試験は `95165ff7fd987ce07268f1d6587cc4e420d37c23`（tree `c3f369f96a649a338d45b68e66d1b324d8f51e93`）へローカル保存した。本書を含む最終候補commit/treeは本作業の成果に固定する。修正差分だけの指定担当による再確認は、この自己確認とは別で結果待ち。

- `hub/lib/chat.js`：`restore-barrier` で見送った後続配送だけを保持し、解除時に1回取り出して同じ送信経路へ戻す。最新queue・停止世代・busy・beforeQueued・canStart・refresh/verify・beforeSendを再確認する。通常の起動失敗は再配送しない。
- `hub/server.js` と `chat.js`：終了保存の完了と失敗を知らせる `settledP` を、完了だけを示す `finishedP` と分離する。起動待ちは前者を待ち、保存失敗は当該runの開発場所と共有Gitだけを閉じる。未解決run・handoffErrors・再起動阻止は残す。cold bootで失敗記録を再検出した場合も同じscopeを閉じ、既存の証拠付きreceipt復旧が成功した時だけblockとleaseを解除する。復旧でhooksやqueueを再実行しない。
- `hub/test/idea-delivery.test.js`：C13の通常queue・正式上限先が解除前0回／解除後各1回、解除の反復で二重配送なし、待機中の原文編集、親session/state/question保全と開始guardの通過を拡張。onSettled例外時にbarrier=false、完了扱いなし、同Git閉鎖、独立scopeの別会話開始可、再送なしを1件追加した。
- `hub/test/update-isolation-handoff-guard.test.js`：既存の10種類の保存失敗注入について、実serverのrestoreReadyが解決しbarrier=falseになる確認を追加した。既存の隔離・cold boot・receipt復旧・再起動阻止も維持した。

| 今回の実行 | 件数 | 結果 |
| --- | ---: | --- |
| 新機能一式（既存81件と追加1件） | 82 | 全件成功 |
| 起動・spool・引継ぎ失敗・上限・queue・統合確認・書込監査 | 158 | 全件成功 |
| 今回の合計 | 240 | 失敗0・skip0 |

先行した配送7件は82件の内数で加算していない。上記全体は製品コード修正後に実行し、その後の変更は検証記録だけ。JavaScript構文検査と `git diff --check` も成功。以前の438件と今回の240件には重複があるため足し合わせない。

新機能一式は前述のコマンドで実行。今回の関係回帰は次のとおり。

```sh
TMPDIR=/private/tmp node --test --test-force-exit hub/test/update-isolation-spool.test.js hub/test/update-isolation-restart.test.js hub/test/update-isolation-handoff-guard.test.js hub/test/limit-integration.test.js hub/test/limit-preflight.test.js hub/test/limit-live.test.js hub/test/queue-edit.test.js hub/test/integration-review-queue.test.js hub/test/integration-write-audit.test.js
```

補助ログは `/private/tmp/idea-barrier-fix-feature.log`（82/82）、`idea-barrier-fix-regression.log`（158/158）、`idea-barrier-fix-targeted.log`（先行7/7）。一時保存であり、結果・再実行対象の正式記録は本書と本作業台帳。確認前に独立再現スクリプトを変更せず実行し、旧候補のCASE A（解除後も配送0回）・CASE B（2.5秒後も全体barrier保持）を再現した。修正後は上記の恒久試験で解除後の開始と実serverの失敗時解除まで確認した。

軽微な所見3件（通常会話停止のpause範囲、候補検査の負荷、入口の回答待ち数）は今回変更していない。本体反映・稼働Hubの停止再起動・実データ移行・実auto-on・実モデル接続は行っていない。

## v2 §11の対応

番号は仕様の受入ケース。下表は隔離fixtureで実施した範囲を示す。複数の検証をまとめた仕様上の1ケースと、test runnerの1件は異なる。

| 番号 | 隔離環境で検査する実効果 | 主な試験ファイル（`hub/test/`） |
| --- | --- | --- |
| 1 | 親busy中の先行保存、GETで空台帳を作らない、保存確定後だけ入力を消す | `idea-storage`、`idea-api` |
| 2 | 同時追加、整理中の別項目追加、片方の原文改訂・回答を保全 | `idea-storage`、`idea-runner` |
| 3 | 同op同bodyは同receipt、別body拒否、別opは別記録 | `idea-storage`、`idea-api` |
| 4 | staging/intent/rename/dir同期と応答断から復旧、壊れた正本を空にしない | `idea-storage`、`idea-lifecycle`、`idea-api` |
| 5 | writer二重所有を拒否、期限だけで所有者を奪わない | `idea-storage` |
| 6 | 会話世代、同文の別出現、周辺抜粋、削除後の原文・未照合表示 | `idea-storage`、`idea-api` |
| 7 | 未設定・複数候補・別Git・消失はfallbackなし、変更前のdirty拒否、旧laneの実装保持 | `idea-runner`、`idea-api` |
| 8 | record/buildの許可分離、初期off整理、pause、停止後の限定prepare | `idea-storage`、`idea-runner`、`idea-review-release` |
| 9 | 同時wakeの配送1回、空待機のCLI/検証0回 | `idea-runner` |
| 10 | 共通Git/重複場所のlease、別Git可、barrier中はadoptのみ、実HTTP統合を待機 | `idea-runner`、`idea-api`、`integration-write-concurrency` |
| 11 | queue保存断のintent照合、破損拒否、unqueue保存失敗で原物保持 | `idea-delivery`、`queue-edit` |
| 12 | prepared未送信とlaunching未知を区別、壊れたspoolを不在扱いしない | `idea-delivery`、`idea-runner` |
| 13 | 終了済みspoolのcold adopt、終了確定1回、barrier中の通常queue/上限先待機、親session保全 | `idea-delivery`、`update-isolation-spool`、`update-isolation-restart` |
| 14 | commit/検証だけで完了にしない、応答なしを読取照合、要件原物・Hub検証ID・人の確認を束縛 | `idea-runner` |
| 15 | 質問A・依存Bを待機し独立Cだけ継続、版付き回答、派生grant、循環拒否 | `idea-runner`、`idea-storage` |
| 16 | dirty checkpointは元項目だけ、保存後urgent優先、途中コード保持、失敗回数を増やさない | `idea-runner` |
| 17 | 外部dirtyは保持して停止、無進展の同失敗は修復停止、人の確認待ちで再実装0 | `idea-runner` |
| 18 | timeoutのprocess group終了、終了不明lease保持、同証拠cache、未照合owner復旧、profile/環境変更 | `idea-review-release` |
| 19 | 偽CLIの正式上限、metadata/役割保存継承、両側待機・一般失敗とpauseの既存回帰 | `idea-delivery`、`limit-integration`、`limit-preflight`、`terminal-limits` |
| 20 | commit後のHTTP応答断、draft保持とreceipt再照合、cold spool復旧 | `idea-api`、`idea-delivery`、`idea-storage` |
| 21 | 空/改変資料・誤marker・別purpose・対象版違いの完了/合格拒否 | `idea-review-release`、`idea-runner`、既存integration review群 |
| 22 | 確認後のsource/target HEAD・dirty・grant・lane・profile/環境変更で旧証拠を不採用 | `idea-review-release`、`idea-api` |
| 23 | prepare→文書→検証→固定確認→apply、実treeと正確な親履歴、merge後保存断の再merge0 | `idea-review-release` |
| 24 | heartbeat重複、古token、期限失効、取消し、再停止、応答なし終了。manifest/releaseRevはheartbeatで不変 | `idea-review-release` |
| 25 | 同treeのempty commitも履歴へ包含、既包含はmerge0、旧pending系は通常取り込み回帰 | `idea-review-release`、`main-merge-oneclick`、`main-merge-preflight` |
| 26 | 一時Gitで実際にreset/clean/新worktree。正本・receipt・制御記録はGit外に1つ。移転・byte復元で同UID | `idea-storage`、`idea-lifecycle` |
| 27 | 手編集md保全、明示移行と二重import、md失敗でもJSON成功 | `idea-storage` |
| 28 | Chrome 1280/390px、変換中Enter、改行、保存shortcut、保存失敗、会話1押し、質問・優先・編集、確認表示 | `idea-api` |
| 29 | 整理/実装結果と原文改訂・回答・取下げの競合。旧結果は履歴、新許可と新計画が必要 | `idea-runner`、`idea-storage`、`idea-review-release` |
| 30 | 型付きidea配送の目的/世代不整合を通常依頼へ降格しない。未導入時auto開始拒否。戻す手順を文書化 | `idea-delivery`、`idea-api` |

## F7の追加分岐

| 枝 | 検査内容 |
| --- | --- |
| 2/29 | まとめ整理の片方だけ原文変更・回答。適合項目だけ採用し、古結果は履歴。派生依存だけでgrantを変えない |
| 4/5/26 | staging、intent、正本rename、dir同期、registry切替の停止注入。receipt・同UID・Git外の記録を照合 |
| 8/19/24 | 初期off整理、pause後の起動拒否、明示prepare例外、再停止→cancelで停止保持 |
| 10/13 | 終了spoolをbarrier中にadopt、終了確定1回、待機queueと上限先を新起動させず親状態を保全 |
| 21/22/29 | organize偽装、複数対象の一部版違い、ready後の取下げ・grant変更で誤完了/合格0 |
| 23/25 | empty commitの履歴包含、既包含のmerge0、source/target移動・未知dirty・merge後ledger保存断で承認外操作0 |
| 24 | heartbeat同op、古token、期限、連続更新、manifest不変、取消しでauto復活なし |

## 実施していない確認と条件

- 実モデルとの接続、実アカウントの利用上限到達、実契約での交代：偽CLIと既存の正式上限fixtureまで。契約CLIを使う実機確認は別の明示承認が必要。
- 稼働Hubの停止・再起動、本体への適用、その後の稼働確認：別ROOTのローカルHub/一時Gitで模擬検証。本体への書き込みは行っていない。
- 本物の台帳mdの移行・削除と実際の自動進行ON：テストデータだけ。人の明示操作が必要。
- OSの実IMEによる変換と実スマートフォン：Chromeに合成中キーイベントを与え、実キーボード操作と390pxの表示を検査。OS入力器と物理端末の操作は未実施。
- 電源断・ストレージ機器故障：保存各境界で例外を注入し再構築して照合した。実機の電源断や媒体故障は再現していない。
- 任意の過去版バイナリでschema 2を開く試験：未実施。旧版へ戻す前のpause・queue/spool照合・正本保全が必要。現行コードの拒否試験から過去版の安全性を断定しない。
- 独立確認：全体の確認は候補3725a76で1回実施し、要修正2件を記録済み。今回修正した起動・配送の差分と影響範囲だけを指定チェック担当へ渡す。再確認の結果は作業台帳に記録し、それまでは新候補を取り込み可・独立確認済みとは扱わない。

## 画像保存の追加（2026-10-15、4.118.0）

この節は画像対応の追加差分の記録。前節までの全体実装・起動修正は既に独立確認され、本体取り込み済み。今回の基準は文字色修正を含む `145a02dcf47a9918b0da69e1e434a97eba32a5ea`。画像対応は本体未反映で、画像差分の独立確認は自己確認と別に行う。最終candidate commit/treeは既存本作業の「成果」「画像対応の実装・自己確認」に記録する。

### 変更範囲と保存契約

- `idea-images.js`（新規）と `ideas.js`：台帳所有の画像登録、形式/実体/容量/件数/所属/パス/リンクの検査、原本とCLI用PNGのhash・同期保存、独立した画像opId/receipt。画像はGit外の台帳制御領域に保存する。画像だけの項目もcontentRev 1で記録し、原本とPNGの同期後にreceiptを確定する。内容の違う同opは拒否し、結果不明は控えで照合する。
- `server.js` と `idea-api.js`：通常の作業uploadを使わない画像POSTと認証付きGET。人のUI識別・同一origin・X-Hubを要求し、保存受付は会話整理の書込待ちと分離する。作業メモ・通常会話・terminalへの副作用なし。
- `idea-projection.js`、`idea-runner.js`、`idea-review.js`：mdへの画像記録、検証済みローカル参照、画像を含む制作許可と固定確認資料。既存の文字だけの許可hashは変更しない。本文改訂でも画像・過去版を保持し、旧制作許可を失効させる。原本/PNGの改変時には制作開始と固定確認を拒否する。
- `idea-lifecycle.js`：画像原本/PNGを照合してbackupへ含める。既存のbyte復元と同じUIDへのrelocateを利用し、移転後はauto停止とlane解除を維持する。未使用のアップロードも保全する。
- `public/ideas.js`、`ideas.css` と `app.js`：複数画像の選択/drop/貼付、プレビュー・保存前の取り外し、IndexedDBの下書き、画像だけ/説明付き保存、再読込・原本表示。共通drop/pasteへの混入を防止する。種類・扱いの選択欄は追加していない。
- 日本語README・CHANGELOGとpackage/lockを4.118.0へそろえた。繁体字は言語パックの規則により未変更・未検証。

### 自己確認の結果

| 対象 | 重複を除く件数 | 結果 |
| --- | ---: | --- |
| 保存・lifecycle・runner・固定確認/反映・API/画面・画像・通常開始・freetalk添付 | 111 | 最終的に全件成功 |
| queue/spool/上限先・起動barrierの配送 | 7 | 全件成功 |
| 今回の合計 | 118 | 残る失敗・skip 0 |

初回の関係一括実行は99/109成功。失敗10件は既存freetalk添付fixtureの準備段階で、macOS既定の一時パスがリンクを通るためだった。`TMPDIR=/private/tmp` に直して該当10/10成功した。最後に原本のハードリンク拒否・backup前の照合・画像受付の保存経路を補い、画像15件/API・画面8件/lifecycle7件の30/30成功を確認した。一括実行の99件と最後の30件は28件重複するため足し合わせず、99 + 10 + (30 - 28) + 7 = 118件。以前の438件・240件とも加算しない。

画像試験は、PNG/JPEG/GIF/WebPの原本一致、画像だけ/複数/説明付き、再構築後の読取、同op/異body、他所属・URL・パス・形式不一致・破損・空・20MB超・10枚超・合計50MB超の拒否、原本/PNG改変とsymbolic/hard link拒否、制作許可と過去版、固定確認資料、Git同居/別台帳のbackup/relocateを検査した。原本・PNG・JSON staging/intent/rename/dir同期の6境界で例外を注入し、receiptと同じopでの再開を照合した。画像の実行資料は偽配送先で確認し、実AIへ送っていない。

Chromeの暗色/明色 × 1280/390pxで画像選択・drop・取り外し・画像と本文の下書き再読込・プレビューを検査。保存済み画像POSTの応答断→再読込→receipt照合、項目保存失敗時の保全、Ctrl+Enter保存、画像だけの記録、保存後の再読込、原本の別タブ表示も確認。4条件ともJS例外0、横はみ出しなし。画像の通常会話・開始画面・terminal向けPOSTは0。既存の文字保存、合成中Enter・改行・Command+Enter、会話1押し保存の画面試験も成功した。

再現用コマンド（隔離ROOT/偽CLIだけを使う）：

```sh
TMPDIR=/private/tmp node --test --test-force-exit hub/test/idea-storage.test.js hub/test/idea-lifecycle.test.js hub/test/idea-runner.test.js hub/test/idea-review-release.test.js hub/test/idea-api.test.js hub/test/idea-images.test.js hub/test/start.test.js hub/test/freetalk-attachments.test.js
TMPDIR=/private/tmp node --test --test-force-exit hub/test/idea-delivery.test.js
```

実行ログは作業コピーの `.ai/work/idea-images-regression.log`（初回99/109）、`idea-images-freetalk-fixed.log`（環境修正後10/10）、`idea-images-final-targeted.log`（最終追加差分30/30）、`idea-images-delivery.log`（7/7）。先行試験の失敗は壊れたPNG fixtureと画面試験側のUUID順への誤期待を修正してから再実行した。製品のエラーを無修正で再試行していない。画面9枚と4条件の `report.json` は `.ai/work/idea-images/` に保管。JavaScript12ファイルの構文、`git diff --check`、日本語の版整合とlockの一致も成功した。

### 今回の未実施

実AIへの画像送信と各CLIでの読取、実OSのドラッグ/クリップボード・実IME、物理スマホ、稼働Hub停止再起動、本体反映、本番台帳の保存/移行、実auto-on、媒体故障・電源断は未実施。画像保管は再インスタンス化とbackup/relocateで確認し、稼働Hubを止めていない。原本GIF等の全フレームをAIが読むことは保証せず、参照PNGは静止画である。ブラウザ容量不足の実機再現と任意の過去版で画像項目を開く試験も未実施。画像変更と共通drop/pasteへの影響だけを指定チェック担当へ渡し、過去の全体確認や無関係な全試験の反復は求めない。

## 日本語だけの自動検査・画像中間ファイルの修正（2026-10-15、4.118.0）

画像差分 `145a02d` → `1217a8c` の独立確認では画像/API/lifecycle 30件が成功し、版検査・公開出力13件のうち版検査1件が失敗した。画像機能全体の再確認は済みで、指摘は「繁体字を明示指定する通常の版検査」と「成功した画像変換の中間PNGの残留」の2件。人が日本語だけにする方針を選択した後の修正基準は `1217a8c24fe318bb8d90ec05e55f66978978721a`。最終commit/treeは既存本作業の成果へ記録する。

### 修正と影響範囲

- `hub/server.js` の反映準備から言語の明示指定を外し、共通 `checkVersion` の既定 `ja` を使う。共通検査と `export-public.js` の日本語検査は変更しない。通常の `version-check.test.js` から繁体字専用の検査を外し、標準profileに同専用検査が含まれないことを確認する。試験fixtureの版証拠も `ja` にそろえる。
- 日本語package/README/CHANGELOGの不一致・不足は引き続き拒否する。古い言語パック・欠落した言語パックは隔離fixtureで模擬し、読取先を日本語3ファイルだけに制限して、文書段階と固定前検査からreadyまで到達し、manifestの版証拠が `languages: ['ja']` になることを確認する。実際の繁体字ファイルは通常の版検査で読まない。
- `idea-images.js` は原本と表示PNGの耐久保存・hash照合後に、今回生成した中間PNGの正確なパスだけを削除する。保存前の例外では資料を保全する。他op・以前の失敗・既存データの走査や削除はしない。原本/PNG/receiptの形式と順番は維持する。空のop別stagingディレクトリは残す。
- 画面・権限・画像形式・種類/扱いの選択欄・自動運転設定は変更していない。版は未反映候補の4.118.0を維持し、日本語変更履歴へ修正内容を追記した。

### 今回の自己確認

| 関係する対象 | 重複を除く件数 | 結果 |
| --- | ---: | --- |
| 通常の版検査・標準profile | 4 | 成功 |
| 反映準備・固定確認・反映の隔離試験 | 25 | 修正後成功 |
| 画像保存・耐久境界・再送・原本保全 | 16 | 成功 |
| 依頼範囲の合計 | 45 | 残る失敗・skip 0 |

初回一括は55件中53成功・2失敗。追加した日本語の文書不一致2件は、reconcile結果の照合後に次のtickで文書段階を開始するfixtureの進行を1回待たず、未開始のrunを参照したことが原因だった。製品変更は追加せず、この試験側の待ちを修正して2件だけ再実行し2/2成功した。初回の依頼範囲45件は43成功・2失敗、修正後の2件と合わせて45件成功と数え、無関係な成功済み試験を反復していない。

範囲外実行の記録：初回コマンドへ `public-export.test.js` 一式を誤って含めたため、繁体字向けの公開出力検査も含む10件を実行した（10/10成功）。これは依頼条件からの逸脱であり、上表45件には含めない。実繁体字の更新・同期は行っていない。追加実行はしない。公開出力の版検査が共通関数の日本語既定を使うことはソースで照合した。

```sh
# 実際の初回コマンド（末尾の公開出力一式の指定は誤り。再実行しない）
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/version-check.test.js hub/test/idea-review-release.test.js hub/test/idea-images.test.js hub/test/public-export.test.js
# 試験側の待ち修正後、失敗した2件だけ確認
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='^反映準備: 日本語の ' hub/test/idea-review-release.test.js
```

ログは `.ai/work/idea-ja-images-fixes.log`（55件の初回と原因）、`.ai/work/idea-ja-images-fixed-release.log`（修正後2/2）。変更したJavaScript/CJS6ファイルの構文と `git diff --check` も成功した。以前の118件・独立30件・全体438件とは足し合わせない。

### 再確認と未実施

今回の共通版検査・反映準備の差分だけをClaude・claude-fable-5-1へ一回再確認として渡す。画像中間ファイルの軽微修正は自己確認で扱い、画像全体・全体48ファイル・無関係な全試験の反復は求めない。再確認結果が出るまでは取り込み可としない。

本体反映・push・公開・稼働Hubの停止再起動・本番台帳の移行/片付け・実auto-on・実AI送信は未実施。実OS/IME/物理端末の再確認もしていない（今回画面変更なし）。繁体字の翻訳・更新・同期・言語パックの公開確認は今回行わない。

## 種類・扱いと台帳レイアウト（2026-10-15、4.119.0）

Opus 5.5が既存本作業の「台帳デザイン確定」に記録した配置・データ契約を実装した。基準は `4376c47b80ed040370dbfd96d5fd70bb2899f302`（tree `44e8ada4a9482bf902e841e262351c9fb8f3968e`）。最終candidate commit/treeは同じ作業の成果に記録する。過去の画像・日本語版検査の独立確認は完了済みで、今回の自己確認とは分ける。

### 変更と影響範囲

- `ideas.js` / `idea-api.js`：6種類のcategory、旧項目の未分類表示、型付きcategory更新、種類別の全件数とサーバー側絞り込み・100件ページ送り。分類はcontentRev/planRev/grant/優先度を変えず、controlRevと既存の汎用rev・改訂履歴だけ更新し、readyなreleaseを失効させない。
- `change:{build:false}` はqueued/blockedかつ対象のopen run・implementationが無い時だけ許可し、record/note・grant=nullへ戻す。他の状態は409。送信していない・取消し済みrunはopen実行として扱わない。既存のopId/receiptと内容版・制御版の競合検査を維持する。viewのcanUnbuildは表示用で、保存時にも同じ条件を検査する。
- `public/ideas.js` / `ideas.css`：作成カード全体drop、64pxプレビュー、画像/種類/扱い/保存の操作列、状態チップと折りたたみ設定、件数付き絞り込みと種類バッジ、項目内の選択と明示保存へ整理。設定済みは要約＋変更、未設定だけ自動展開。自動進行・反映の契約は変更しない。
- 本文/画像/種類/扱いの下書きを保持。項目内の種類と扱いは既存の型付き更新を順番に実行し、途中で応答断となっても同じopの控えを照合してから次へ進む。保存中は項目単位で操作を無効にし、再描画後の二重送信も防ぐ。応答断で照合待ちとなった項目は、選択欄を固定して元の操作を先に確定する。キーボードの自然な順番を保つためヘッダー操作はDOM上では作成フォームの直後に置き、表示はヘッダー位置へ配置した。
- 4.119.0のpackage/lock、日本語README/CHANGELOG、使い方を更新。外部素材・他画面・繁体字・実行設定の変更なし。

### 自己確認

| 対象 | 重複を除く件数 | 結果 |
| --- | ---: | --- |
| 保存・旧項目・category/解除条件と既存API/画面 | 24 | 成功 |
| 画像・runner・固定確認/反映・日本語版検査 | 69 | 成功 |
| 新しいAPIとChromeの配置・操作 | 2 | 修正後成功 |
| 今回の合計 | 95 | 残る失敗・skip 0 |

自然なTab順と項目保存中の操作制限の調整後、新Chrome画面1件と既存API/画面8件を再確認して全件成功した。最後に照合待ちの選択固定を追加し、影響する新Chrome画面1件だけを再確認して成功した。95件は試験ケースの重複を除く数であり、反復した8件・1件や過去の試験件数を足していない。69件の対象コードはその後変更していない。

Chromeは暗色/明色×1280/390px（高さ900）で空・未設定、保存失敗、記録あり・設定済み、設定要約、画像下書き、保存済み画像、答え待ちの7状態を撮影（28枚）。画像ありの下書き保持・drop・取り外し・応答断/項目保存失敗の復旧は既存画像画面試験も成功。新画面では選択だけで保存しないこと、分類と制作許可の分離、画像だけのrecord保存、保存後の初期値復帰、絞り込み、質問、設定の変更、category保存成功後の応答断→再読み込み→receipt照合→build解除1回を確認した。

Tabは本文→画像→種類→扱い→保存→状態→設定→閉じるの順で、Shift+Tabでも戻れる。設定・一覧の操作はその後に続く。既存C28で合成中Enter・通常改行・Command+Enter、新画面でControl+Enterも成功。4条件ともJS例外0・横はみ出しなし、表示ボタン/選択欄は高さ44px以上、390pxでは全画面・保存48px。placeholder/mutedとpanelの測色は暗色6.56:1・明色4.97:1。最終画像の暗色PC・明色スマホも実見した。通常会話・terminal・作業添付へのPOSTは0。

実行コマンドとログ（すべて隔離ROOT/一時Git/ローカルChrome、実AIなし）：

```sh
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/idea-storage.test.js hub/test/idea-api.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/idea-images.test.js hub/test/idea-runner.test.js hub/test/idea-review-release.test.js hub/test/version-check.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/idea-redesign.test.js
# 最終の画面調整と試験の待ち修正後、影響範囲だけ再確認
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='redesign Chrome' hub/test/idea-redesign.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/idea-api.test.js
```

ログは `.ai/work/idea-redesign-first.log`（24件）、`idea-redesign-related.log`（69件）、`idea-redesign-ui-fixed.log`（先行2件）、`idea-redesign-ui-verified2.log`（先行Chrome1件）、`idea-redesign-ui-final-guard.log`（選択固定後の最終Chrome1件）、`idea-redesign-api-final.log`（最終8件）。途中の画面試験はfixtureのPORT=0とサーバーのHost照合の不一致、逆Tab回数の1回過多、既に保存された分類表示だけを待って次の扱い保存を待たない試験の不備で失敗した。原因を直してから該当画面だけ再実行した。失敗ログ `idea-redesign-ui.log` / `idea-redesign-ui-final.log` / `idea-redesign-ui-verified.log` も保持している。

画面28枚と4条件の `report.json` は `.ai/work/idea-redesign/`。既存画像画面の9枚とreportは同ディレクトリの `images-regression/` に分け、過去の画像対応の証拠を上書きしていない。変更JS6ファイルの構文・diff --check・日本語の版とpackage-lock整合は成功し、`idea-redesign-static.log` に版検査結果を保存した。

### 独立確認と未実施

今回のcategory/扱い/画面と既存保存への影響だけを同じ作業のClaude・claude-fable-5-1へ一回渡す。自己確認95件成功は独立確認済みを意味しない。過去の全体・画像差分の確認や無関係な全試験を反復しない。

本体は `1b80baf` / cleanを読み取りで再照合し、未変更。本体反映・push・公開・稼働Hub停止再起動・本番台帳保存/移行・実auto-on・実AI送信・繁体字更新/専用検証は未実施。実OSのIME/ドラッグ操作、物理スマホ、OS/ブラウザ自体の故障、実環境での表示と制作は未実施。画面検証はChromeのローカル自動操作と390px表示による。


## 対処済み項目の削除停止の修正（2026-10-16、4.121.12）

開始コピー `d77b40640b16c10a9921865aadaed5ad05e8a3cb` と最新本体がcleanで、登録worktree・共有Git・包含が一致することを再確認した。本体 `7cb754e5f8322f9f217ec535df752d3bc06f5270` を作業コピー側だけへfast-forwardし、これを修正baseとした。本節を含む最終commit/treeは同じ作業の成果へ記録する。本体は未変更。

### 原因と変更範囲

- `hub/lib/idea-erase.js`：削除対象自身に結び付いた古い整理runが結果不明のまま残ると永久に拒否していた。取り下げ済み・許可なしの単一対象、古い停止世代、読み取り専用のorganize、自動進行off・一時停止中に限定し、依頼識別を含む実行証拠も再検査してから削除トランザクション内で廃止する。削除控えの `cancelledRuns` に取消理由と停止世代を残す。`closed=true` や成功、未送信には書き換えず、整理を再送しない。共有対象、制作・確認、未保存結果、spool、継続区間、不明な証拠や依頼先には拡張しない。
- `hub/lib/idea-dispatch.js`：run metadataに加えてrequest/queue/上限継続の依頼識別で、実行中・queue・会話・spoolの一致を確認する。metadataの欠けたassistant結果も未処理結果として拒否する。受付記録だけなら引き続きunknownであり、成功根拠にはしない。既存の削除済みrunの遅延結果拒否・配送前検査・停止世代フェンスを使用する。
- `hub/lib/idea-erase.js`：初回保全した空でない手書きmdを一律に拒否していた。初回rev1またはその後へ引き継いだ保全根拠と同一hashで、対象の全履歴がverified captureかつ本文/先頭行/ID/画像識別を含まない旧mdだけ、完全に同じbytesで保持する。削除後のprojectionには生成hashを与えず、初回保全根拠 `preservedOrigin` を引き継ぐ。これにより後続削除・通常投影・再読込でも旧原本を上書きしない。既知の移行元行と生成mdの消去は既存処理を保持し、後日の手編集・対象を含む原本・保全根拠なしは拒否する。
- 関係試験2ファイル、使い方、本書、package/lockと日本語README/CHANGELOGだけを更新。画面・通常会話の停止操作・設定・本体コード・実データ・繁体字は変更しない。

### 今回の自己確認

| 対象 | 件数 | 結果 |
| --- | ---: | --- |
| 削除可否・完全削除、停止済み対象の廃止と旧md保全 | 50 | 全件成功 |
| 削除復旧・配送・runner・既存API/画面 | 76 | 全件成功 |
| 2つの原因が同時にある台帳の正式API経路、2件だけの削除・receipt・再読込 | 1 | 成功 |
| 日本語の版整合 | 4 | 全件成功 |
| 合計（重複加算なし） | 131 | 失敗・skip・cancel・todo 0 |

追加7試験では、旧整理依頼の廃止を成功と区別すること、対象外項目/元会話の不変、遅延結果と古いadd receiptからの復活拒否、15条件の拒否分岐、metadataなしのqueue/実行/結果/spoolと壊れた証拠の拒否、初回原本の二連続削除/backup/relocate/restart/通常更新での保全、消去途中の停止と同opId/receipt復旧、対象を含む原本/後日編集/初回根拠なし等の6分岐を確認した。さらに、2つの原因を併せ持つ隔離台帳で `IdeaAPI.handle` の正式経路（人UIの認証条件を含む）を使い、対象2件だけが削除され、別項目と旧mdを保持し、同opIdの再送と再読込後のreceipt/404が一致することを確認した。実台帳での削除を行った証拠ではない。

```sh
TMPDIR=/private/tmp HUB_LANG=ja node --test hub/test/idea-delete-availability.test.js hub/test/idea-erasure.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test hub/test/idea-erasure-recovery.test.js hub/test/idea-delivery.test.js hub/test/idea-runner.test.js hub/test/idea-api.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-name-pattern='official delete API' hub/test/idea-delete-availability.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test hub/test/version-check.test.js
```

ログは `.ai/work/idea-delete-fix/target.log`、`regression.log`、`combined-api.log`、`version.log`。今回の実行は初回から成功し、無修正の再試行なし。JavaScript変更4ファイルの `node --check`、`git diff --check`、package/lock一致も成功。最初の126件後は追加したAPI試験1件と版4件だけを実行し、成功済みの全試験は繰り返していない。新たな画面変更はないため、画面の全状態の撮り直しは行わない。関係する既存APIのChrome試験は76件に含む。

### 実データと未実施

削除承認済みは `561e58cd-f068-4c40-b210-3f3873c25742` と `f7eda9ad-035d-403f-9e2a-68742bc0a881` の2件だけ。旧mdは2685bytes、sha256 `4d213154d3f36145f3bd6d9ea12e16346d3eed67fc3a8bffdf46afc0e1162970` で初回保全記録と一致する。関連する旧runは `b62bea13-9b88-40be-8ace-ba2d9cd64f82`、停止世代1/現在18のreadOnly organizeであることを読み取りで確認した。

両件とも未削除。稼働版には修正がないため、削除APIを実データへ送信していない。本体反映と再起動は別途人の承認・操作が必要であり、今回実施していない。削除安全性に関わる今回差分だけをFable 5.1の独立確認へ渡す。独立確認後の本体反映・新版稼働を確認してから、承認済み2件について各1つのopIdを固定し、正式削除/receipt/再読込で結果を確かめる。旧帳の照合や移行、無関係な会話の停止を人へ求めない。元会話・元画像・他作業・他項目・旧帳を保持する。push・公開・実auto-on・実AI送信・繁体字専用検証は未実施。

## 待ち指示の台帳退避（2026-10-16、4.122.0）

人が選択した［台帳へ退避］の機能追加。前節の削除対応は、その後、人の取り込み・再起動と削除済みの受付控え確認まで完了している（既存本作業に記録）。今回は実待ち指示の移動を行わない。開始時にコピー・本体のclean、登録worktree・共有Git・包含を再照合し、コピーだけを最新本体 `d7a02ea11bfe2a1877f27b04f61958c50216fa9b` へfast-forwardした。同SHAを今回のbaseとし、最終candidate commit/treeは既存本作業の成果へ記録する。

### 変更と確認した安全性

- `queue-retreat.js` に、サーバー上の最新指示のhash照合、起動証拠の検査、画像の原本検査、台帳内 `queueRetreats` のprepared→saved→complete記録を追加。台帳の保存控えを確かめてから対象だけを待ち列から外す。本文全文と別表示の原文、元project/task/queueID、担当・モデル等を項目のsourceへ保存する。intent=record、grantなし、現行の既定ラベル「メモ」で、整理要求も出さない。種類を許可へ流用しない。
- 同opIdと入力hash・受付控えで再開し、別opへの変更や最新queueとの不一致を拒否する。準備記録と項目/receipt保存の途中、待ち列保存の失敗、待ち列削除後の停止を照合する。保存が不明なまま成功・未送信扱いにしない。完了後の処理用snapshotは除去し、項目の完全削除でも内容を持たない退避識別を残して古いqueueからの復活を防ぐ。退避途中の項目は削除を拒否する。
- `chat.js` / `server.js` に編集・取消・手動/自動開始・非同期preflight後・spawn直前の共通フェンスを接続。起動時は台帳を復旧し退避を照合してから既存barrierを解除する。復旧不能な指示はフェンスを残し、別の会話の起動を妨げない。現在の実行、別queue、停止世代や制作許可は変えない。通常指示/普通の委任だけを対象とし、freetalk、管理フラグ/専用ID/統合関連記録、起動準備・会話/spool証拠がある指示は拒否する。
- project添付の正規参照ブロックと所有先/画像IDの対応を検査し、PNG/JPEG/GIF/WebPの原本を台帳所有の保管へ複製する。プレビューPNGと元GIF等を取り違えず、元画像は残す。新しいqueueはprojectImagesも保持する。欠落・別所有先・明示メタデータとの不一致・リンク/ハードリンク・形式/容量/件数違反を拒否し、任意の本文中パスは開かない。保管/移転、手編集mdの保全も確認した。
- `app.js` / `app.css` に行ごとの44px操作、処理中・失敗・照合・成功と台帳を開く導線を追加。未保存のqueue編集がある時は退避を無効にする。応答断ではlocalStorageへ保存した同opIdで確認し、再読込で重複作成しない。画面全体の改装・本体への反映は行わない。
- 4.122.0のpackage/lock、日本語README/CHANGELOG、使い方を更新。共通の版検査は既定の日本語だけを使用し、繁体字の変更・同期・専用検証は行わない。

### 自己確認（重複を除く226件）

| 対象 | 件数 | 結果・ログ（`.ai/work/queue-retreat/`） |
| --- | ---: | --- |
| 新しい耐久保存・画像・競合・復旧・保管/消去・自動実行防止 | 24 | 成功。unit-final.log 16、recovery-extra.log 6、retention-extra.log 2 |
| 正式HTTP経路・Chromeの操作と表示 | 2 | 成功。ui-final.log |
| 既存の台帳保存・画像・API/画面・配送・消去・保管移転 | 75 | 成功。regression-ledger.log |
| 既存の通常queue編集・上限結合 | 17 | 成功。regression-ordinary.log内の該当17件 |
| 既存の上限preflight | 38 | 試験の正常再起動を修正後、全件成功。limit-preflight-final.log |
| 既存の統合確認queue | 66 | 試験の正常再起動を修正後、全件成功。integration-review-queue-final.log |
| 日本語の版・履歴整合 | 4 | 成功。version.log |
| 合計 | 226 | 残る失敗・skip・cancel・todo 0 |

新unitの24件は段階的な追加分だけ実行しており、先に成功した16件を後の6件/2件へ重複加算していない。通常queue/上限結合17件は、上限preflightと同時に実行したログから区別した（同ログ全55件中19成功/36失敗のうち、preflight2成功/36失敗は修正後の38件へ置換し、件数を重複加算しない）。過去の全体・画像対応や成功済み無関係試験は反復していない。

新しい障害注入は、退避4段階、準備記録のstaging/intent/rename/directory-sync、項目/receiptの同4境界、queue保存不可を含む。準備後の手動/自動開始・編集/取消拒否、非同期preflight競合、保存済みだが待ち列に残る指示を実行中fixture終了後も配送しないこと、実サーバーのcold bootでbarrier解除前に一度だけ完了することを確認した。自動進行が有効な隔離台帳でも、退避だけでは整理/制作の起動は0回だった。

主な実行コマンド（隔離ROOT/一時Git/ローカルのfake CLIのみ。新unitの後半は追加分をname-patternで選択）：

```sh
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/queue-retreat.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='automatic dispatch|item receipt|server cold boot' hub/test/queue-retreat.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='backup/relocate|enabled automatic runner' hub/test/queue-retreat.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/queue-retreat-ui.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/idea-storage.test.js hub/test/idea-images.test.js hub/test/idea-api.test.js hub/test/idea-delivery.test.js hub/test/idea-erasure.test.js hub/test/idea-lifecycle.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/queue-edit.test.js hub/test/limit-preflight.test.js hub/test/limit-integration.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/limit-preflight.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/integration-review-queue.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/version-check.test.js
```

### 途中の失敗と原因の修正

- `unit-first.log`：13成功/3失敗。キー順の異なるJSON文字列を比較した試験をcanonical hashの比較へ変更。明示的な空のprojectImagesと旧参照ブロックの不一致を見逃した製品側の検査を修正。非同期beforeQueuedの呼び出し前に検査していた試験に待機を追加。原因を直してから16件を再確認した。
- `ui-first.log`：2件失敗。試験の同名変数の初期化前参照と、スマホで会話入力欄を開く前の操作が原因。fixtureの名前と表示待ちを直してから、同ファイル2件が成功した。
- `regression-queue.log` / `regression-ordinary.log`：既存の統合確認/上限preflight試験がserver.closeだけで再起動し、正常終了の印を残していなかったため、基準版に存在する異常終了保護が働いて起動を拒否した。`integration-diagnostic.cjs/.log` でbarrier=falseでもstopControlのall/pausedがtrueであることを特定。試験2ファイルの正常再起動に既存のcleanExitを加え、製品の停止契約は変更していない。失敗が連鎖していた最初の統合試験は隔離試験プロセスだけを停止し、修正後の該当2ファイルだけ再実行して38/38、66/66成功。稼働Hubは停止していない。

### 画面・静的確認・未実施

専用Chrome wrapper `~/.local/bin/chrome-headless-arm64` で暗色/明色×1280/390pxを確認し、各条件の準備・処理中・保存失敗・成功・保存済み画像の計20枚を `.ai/work/queue-retreat/` へ保存した。`report.json` に4条件ともキーボード/処理中/失敗保全/応答断後の再読込/画像原本が成功、通常会話等の送信0、JS例外0を記録。Tab/Shift+Tab/Enter、編集中の退避禁止、処理中の二重操作防止、44px操作、横はみ出しなしを確認した。暗色PCの準備と明色スマホの成功画面を実見した。Chrome本体は直接起動していない。

変更したJavaScript11ファイルの構文・`git diff --check`・package/lock整合は成功し、`static.log` に記録した。今回の自己確認と、これから依頼するFable 5.1の独立確認は区別する。今回の保存/配送差分だけを一回渡し、全体や成功済み無関係試験の反復は求めない。

本体は `d7a02ea` / cleanのまま未変更。実待ち指示の退避/取消、実台帳への保存、実AI送信、本体反映、稼働Hubの停止再起動、push・公開、実auto-onは未実施。実OSのIME/ドラッグ操作、物理スマホ、実アカウントの利用上限、実AIからの画像参照、OS/ブラウザ自体の障害は未検証。画面確認はローカルChromeの自動操作と390px表示による。実環境で使うには独立確認と人の取り込み・再起動が先に必要で、今回の実待ち指示の移動まで許可されたとは扱わない。

## 台帳退避 R1：画像拒否後の永久保留の修正（2026-10-16）

Astraの独立確認で、通常添付が受理する6400×6400 PNG（39889 bytes、4000万画素超過）と署名8 bytesだけの破損PNGを退避すると、項目未保存のままpreparedが残る問題を確認した。元の再現2ケースは不具合の証拠であり、機能合格件数へ加算しない。今回の修正baseは `2ca7e17ee4444d2df4edf539c422e54bf948f83c` / tree `be6139394e8bf3c9133670910677a95521af10e5`。版は未反映候補の4.122.0を維持し、過去の226件・画面20枚・上限や統合の全試験は反復しない。

### 修正と影響範囲

- `queue-retreat.js`：既存の画像保存処理（完全decode、画素上限、原本/PNGの耐久保存・hash照合）を全枚数について済ませてからpreparedを確定する。再開時は同じ画像opId/receiptを再使用する。画像拒否や画像受付途中の障害では退避記録・項目receiptを作らず、元の指示を保持する。先に受け付けた画像の控えは保持し、他opの資料は片付けない。
- `app.js`：画像拒否後に受付控えの問い合わせまで途切れて再読込した場合も、正式GETでstate=absentと確認できた時だけローカルの保留を解く。従来の失敗直後の照合と同じ判定を再読込にも使う。prepared/saved/unknownをabsentへ置換せず、サーバーのguard・開始/編集/取消フェンス・停止世代は変更しない。旧preparedを一括解除する移行処理も追加しない。
- 原文・表示原文・画像原本・別の待ち指示・制作許可の契約は維持。原本の差替え/欠落など保全を照合できない準備済み操作は引き続き停止する。

### 今回の自己確認（29件、失敗/skip/cancel/todo 0）

| 対象 | 件数 | 証拠（`.ai/work/queue-retreat/`） |
| --- | ---: | --- |
| 画像拒否（上限超過/破損×先頭/2枚目）、画像受付4障害境界、準備後3境界の画像op再使用 | 11 | r1-unit.log |
| 影響する既存のprepared/保存/receipt/queue保存、preflight、復旧・cold boot・自動配送の保護 | 17 | r1-unit.log（上記と合計28） |
| Chrome：拒否後の再試行/編集/取消、受付問い合わせ断→再読込→absentで解除 | 1 | r1-ui-lookup-final.log、r1-ui-report.json |

4つの画像拒否ケースは、拒否直後と再オープン後の項目0/退避receipt absent、元queue・原本bytes・他queue不変、開始条件通過、実際の編集/取消、修正後の同op再送で項目1を確認した。画像受付の原本/PNG/intent/renameで停止しても項目は未保存で操作可能。prepared/before-save/saved後の障害ではフェンスが残り、起動復旧後も画像識別と項目は増えないことを確認した。前回の結果不明・原本欠落・自動配送保護も今回の影響分だけ再確認した。

Chromeは専用wrapperをHUB_TEST_CHROME未指定で使用。暗色1280px・明色390pxの2条件で、実サーバーによる壊れた画像の拒否、再試行、編集保存、キーボードでの取消を確認した。問い合わせ断・unknownの間は保留を維持し、起動時の照合中は再試行も直列化して、古い応答で新しい操作のopIdを消さない。再読込でabsentが確定してから操作できる。実AIの送信0/画面例外0。画像原本と別queueを保持し、画面2枚 `r1-dark-1280-rejected.png` / `r1-light-390-rejected.png` を実見した。過去の全画面確認は反復しない。

```sh
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='image rejection|image acceptance|accepted image|durable boundary|ledger .* failure|item receipt|queue disk failure|failed recovery|preflight race|server cold boot|automatic dispatch' hub/test/queue-retreat.test.js
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper R1' hub/test/queue-retreat-ui.test.js
```

今回の試験は初回で全件成功。再読込時の照合と再試行の直列化・unknown維持を追加した後は、該当Chrome1件だけを再実行して成功（r1-ui-lookup-final.log）。最初のr1-ui.logと重複加算しない。変更したJavaScript4ファイルの構文、diff --check、package/lockの4.122.0一致も成功（r1-static.log）。機械可読な結果と候補commit/treeは `r1-verification.json` および既存本作業の成果に保存する。

着手時、本体は別作業の取り込みで `4444feb2d0d04831c0f610ebc9764a2f7ded6b46` / cleanへ進んでおり、元base d7a02eaの包含と共有Gitを照合した。本修正は登録済みコピー2ca7e17だけで行い、その本体の変更を上書き・再合流していない。本体反映/再起動・実待ち列の移動取消・実台帳保存・実AI送信・push/公開・繁体字更新/専用検証は未実施。自己確認と独立確認を区別し、今回指定のAstraへR1修正差分と影響範囲だけ再確認を渡す。取り込みはその確認後の人の操作。

## 台帳退避 R2：画面切替前の遅延応答による退避控え消失の修正（2026-10-16）

AstraによるR1差分再確認は元の画像拒否問題を解消と判定した一方、破損画像拒否後の照合GETを遅らせ、［ターミナル］→［会話］で画面を作り直した後に別指示を保存すると、古いabsent応答で新しいopIdが消えるR2/P2を再現した。その再現1件は合格件数に含めない。今回のbaseは `3b57172b034b435fd556fbfe7d668ad3515a2bea` / tree `69fd1c73cadd92087d06a5a2cc39e701d96d6d4f`、未反映の版4.122.0を維持する。

### 修正と自己確認

- 製品変更は `hub/public/app.js` の退避応答処理だけ。POST・失敗後GET・再読込GETごとに要求時のproject/task/queueId/opId/expectedを捕捉する。入力ノードの同一性を画面世代として使い、現在の作業画面とローカル保留、および実際のlocalStorage控えがすべて一致する場合だけ応答を反映する。画面切替前の応答やエラーで現在の控え・保留・表示を書き換えない。ハッシュ計算中に画面が変わった場合も新たな退避を送らない。
- completeにも同じ所有照合を適用する。正式absentのみ未準備の控えを解除し、unknown/prepared/savedは解除しない。元R1の全画像受付→prepared順、サーバー側receipt・保存・編集/取消/起動フェンス、本文・原本・他queue・制作許可は変更していない。
- 追加Chrome2件：実UIの画面切替と本物absentの応答遅延を再現し、新操作がsaved直後またはprepared直後に停止しても古い応答で控えが消えないことを確認。さらにunknown応答のまま再読込して保留・編集取消拒否を維持し、［退避を確認］から元のopIdで1回だけ完了。2回のPOSTは同一opId、項目1、原本文全文・画像原本・他queue不変、通常送信/委任0・画面例外0。暗色1280px/明色390px、専用Chrome wrapperを使用した。
- 影響する既存R1 Chrome1件も再確認。拒否後の再試行/編集/取消と、再読込時のunknown維持/正式absentのみ解除が成功した。今回合計3件成功・失敗/skip/cancel/todo 0。過去29件/226件は合算せず、全反復しない。

```sh
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper R2|Chrome wrapper R1' hub/test/queue-retreat-ui.test.js
```

証拠は `.ai/work/queue-retreat/r2-ui-final.log`、`r2-ui-saved.json`、`r2-ui-prepared.json`、保留/完了画面4枚、`r2-verification.json`。暗色PCの保留画面と明色スマホの完了画面を実見した。既存R1のreport/画面は今回の影響試験で再生成されている。以前の最終ログ・証拠台帳・再現資料は保全している。

初回の新規2件（r2-ui-first.log）は試験側の不備で失敗した。本文を存在しないoriginalプロパティで比較していた箇所を既存textへ直し、スマホでモード切替を押す前に［情報と操作を開く］操作を追加した。原因修正後、上記の関係3件が成功した。初回結果を成功へ加算しない。変更JavaScript2ファイルの構文、diff --check、package/lock整合は `r2-static.log` に記録する。

本体は着手時の `4444feb2d0d04831c0f610ebc9764a2f7ded6b46` / cleanのまま。実待ち列の移動/取消・実台帳保存・本体反映/稼働Hub停止再起動・push/公開・実AI送信・実auto-on・繁体字更新/専用検証は未実施。物理スマホや実OS障害等の既存の未検証条件を保持する。今回はSolによる自己確認であり、ローカル保存後、今回だけ指定されたAstraへR2差分と影響範囲だけを一回渡す。候補commit/treeは既存本作業の成果と `r2-verification.json` に記録し、本体取り込みは差分確認後の人の操作とする。

## 本体の待ち指示編集・中断続行と台帳退避の保全合流（2026-10-16）

人の取り込みは内容衝突で中止され、正式控え `e5f80f88-1cfc-4653-a9b7-62e562ee5766` はaborted。作業中による待機ではなく、同じ接続箇所の変更が原因だった。作業コピーの `a1ba2dc61f613146ec2b8fa2f342d1c1760327d4` / tree `5472739d363c396a166fdc7f5dc3fb88a125ee51` に、本体 `4444feb2d0d04831c0f610ebc9764a2f7ded6b46` をコピー側だけで合流した。共通祖先は `d7a02ea11bfe2a1877f27b04f61958c50216fa9b`。着手時の登録worktree・共有Git・両側cleanを照合し、本体は変更していない。

### 解消した接続と影響範囲

- 衝突7ファイル（README、CHANGELOG、chat.js、package/lock、app.js、server.js）を両機能が残る形で解消。版は4.122.0とし、本体側4.121.13〜4.121.20を含む日本語の履歴を残した。繁体字ファイルは変更しない。
- `chat.js` はcontinuationOptionsと退避開始フェンスの両方を通す。後続queueへ前のunfinishedIdを持ち越さず、中断記録の保存と続行処理も維持する。`server.js` はprepareSwitch/launchAdvance/unfinishedの経路と退避route、起動復旧前の退避フェンスを保持した。
- `app.js` と `server.js` はattachmentDraftとprojectImagesを併存させ、担当/添付編集、受付済み409の下書き保全、［すぐ追加］、R2の現画面/要求時操作/現在の控えの照合を維持。R1の全画像受付→prepared順は未変更。
- 添付編集で外した画像IDが古いprojectImagesに残らないよう、残存添付からmetadataも更新する。退避は保存後の最新本文・担当・添付だけを使い、元画像・別queue・原文中の任意パスは保持する。添付をすべて外した場合も同じ契約とした。
- 本体から取り込まれたchat-continuation/queue-edit等の機能全体を作り直さず、合流で変わる編集・受付・中断続行・退避の接続だけを関係検証した。

### 今回の自己確認（重複除去78件、残る失敗/skip/cancel/todo 0）

証拠の保存先は `.ai/work/queue-retreat/`。初回の失敗ログも残し、修正後の同じ試験を重複加算していない。

| 対象 | 件数 | 成功の証拠 |
| --- | ---: | --- |
| 待ち指示の担当/添付編集・画像、未完了記録・中断続行、保存済み退避先の続行禁止 | 35 | merge-queue-first.logの33件＋merge-queue-recovery.logで失敗2件を解消（再実行3件のうち1件は既成功） |
| 既存画面の担当/添付下書き・切替・受付済み/未受付409と通常200 | 17 | merge-app-first.log（3）、merge-accepted.log（14、入れ子9件を含む） |
| 最新画像metadata・同opの正式HTTP退避、暗色1280/明色390で担当/添付編集→退避 | 3 | merge-http-final.log（1）、merge-ui-final.logの新規2件 |
| 合流で影響するR1拒否後再操作とR2遅延absent・saved/prepared復旧 | 3 | merge-r1-final.log（1）、merge-r1-r2.logのR2成功2件 |
| 退避のreceipt/耐久境界・queue保存失敗・preflight・cold boot・自動配送フェンス | 16 | merge-guards.log |
| 日本語の版検査 | 4 | merge-version.log |

```sh
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/queue-edit.test.js hub/test/queue-failure-continue.test.js hub/test/queue-attachments.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='model edit after|merge retreat|failed unfinished-record write' hub/test/queue-failure-continue.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='queue model draft|queue image viewer|composer preview|accepted.*409|cutover|queued.*409' hub/test/app-ui.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='受付済み409|受付証拠なし409|通常200の受付後' hub/test/app-ui.test.js
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='merge HTTP' hub/test/queue-retreat-ui.test.js
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper merge|Chrome wrapper R1' hub/test/queue-retreat-ui.test.js
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper R2|Chrome wrapper R1' hub/test/queue-retreat-ui.test.js
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper R1' hub/test/queue-retreat-ui.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='preflight race|server cold boot|automatic dispatch|queue disk failure|durable boundary|item receipt' hub/test/queue-retreat.test.js
TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit hub/test/version-check.test.js
```

### 途中の失敗・逸脱と修正

- 中断記録の保存失敗を意図的に残す既存試験の後に、同scopeを使う新しい試験が続いていたため、保護によって次の2件の初期送信が409になった。意図的な未解決障害試験を同ファイルの最後へ移し、失敗した2件と当該障害試験だけを確認して3/3成功。製品の保護は解除していない。
- 新しいHTTP試験の準備でbusyを作らずmode=queueを送ったため、通常送信へ正規化され、**隔離した合成データから実Codex CLIを誤って1回起動した**。終了コード0で終了済み。実待ち列・実台帳・本体への操作はないが、実AI送信なしという扱いにはしない。HUB_DRY_RUN/HUB_AI_HOMEだけでは起動を防げなかった。試験のbusy準備とqueued=trueの検査を追加し、PATHの先頭へcodex/claude/agy/grokの拒否用実行ファイルを置き、終了時に起動試行0も検査する形へ修正。以後は模擬実行だけ。人へ経緯を報告済みで、終了・起動情報と出力は `merge-cli-deviation/` に保全した。
- 新しいChrome試験はfixtureにroles設定が無く担当候補が表示されなかったため、既存テンプレートのrolesを複製。HTTPの画像0枚の検査は省略可能なimagesを空配列として判定するよう修正した。R1の旧fixtureも、新しい編集UIに合わせて表示ラベルのモデル値と本文/添付参照の分離を直した。製品側の既存編集契約は変更していない。
- `merge-ui-first.log` / `merge-ui-fixed.log` / `merge-ui-final.log` / `merge-r1-r2.log` の失敗結果を保持し、原因修正後は該当範囲だけ確認。diffのEOF空行1件は削除し、最初の静的結果を `merge-static-first.json` に保全した。

### 画面・静的確認と未実施

専用Chrome wrapperで暗色1280px/明色390pxの編集・完了4画面を生成した。担当をFable 5.1へ変更し、2枚中1枚を外して保存後、Tab/Shift+Tab/Enterで退避できること、編集中の退避禁止、44px以上、横はみ出しなし、原本と別queueの保全を確認。これらの画面試験の通常送信/委任0・画面例外0を `merge-ui-dark.json` / `merge-ui-light.json` に記録した。暗色の編集画面と明色スマホの完了画面を実見した。R1/R2の画面証拠を再生成する前に、旧JSON/PNGを `merge-prior-evidence/` へ原文保全した。

JavaScript12ファイルの構文、差分の空白検査、package/lockの4.122.0一致を確認した（merge-static.json）。合流commit/両親/tree、固定mainとの再合流結果、変更差分とログ/画面hashは `merge-verification.json` と既存作業の成果に記録する。過去の226/29/3件をそのまま反復・加算せず、今回78件は自己確認として独立確認と区別する。

本体は固定した4444febのまま。実待ち列の移動/取消・実台帳保存・本体反映/稼働Hub停止再起動・push/公開・実auto-on・繁体字更新/専用検証は未実施。実AI送信については上記の合成データの誤起動1回を明記する。物理端末・OS障害等の既存の未検証条件は保持する。合流の保存/配送と画面の接続差分だけを既定のClaude・Fable 5.1へ一回渡し、結果が出るまで本体取り込みは保留。取り込み・再起動は人の操作とする。

合流コードと検証文書は `6bca5cbfaf53d111a4418df48ee4b86cb4beefe6` / tree `f16f170d8cf401a2ee35b26120b9d37acea3b69c` に保存した。両親はcopy `a1ba2dc61f613146ec2b8fa2f342d1c1760327d4` とmain `4444feb2d0d04831c0f610ebc9764a2f7ded6b46`。この保存先の追記だけを後続の文書commitへ保存し、最終候補のcommit/treeと固定mainに対するmerge-tree結果は `merge-verification.json` と既存本作業の成果で管理する。コード・試験はこの合流commitから変更していない。

## 合流独立確認M1：添付編集の遅延応答と退避の競合修正（2026-10-17）

人が指定したAstraの合流独立確認で、添付編集の本物のGET応答を遅延させ、退避の保存直後に障害を起こすと、古い応答が編集欄を開いて同画面の［退避を確認］を妨げるM1/P2が再現された。旧再現資料 `merge-astra-edit-race-*` と過去の誤CLI起動記録は保全した。

基点は `4ac5e50571ffc9fb0869b4cac6e019af545e7620` / tree `39a85eeb1aafe4ad80e352b6f428b249a4819e15`、固定本体は `4444feb2d0d04831c0f610ebc9764a2f7ded6b46`。製品の修正は `hub/public/app.js` の添付編集の取得応答だけ。取得要求ごとの所有者を持ち、別の待ち指示操作が始まったら無効にする。応答の反映前に、同じ会話入力ノード（画面世代）、要求の所有者、退避の処理中/保留/実localStorage控え、編集下書き、最新queueの全文スナップショットを確認する。古い成功・エラーを反映せず、通常の編集と［戻る］は維持する。

サーバー、保存/制作許可/配送の契約、receipt、unknown/savedの保護は変更していない。元R1の全画像受付→prepared順とR2の応答所有者照合も維持。公開前候補の版は4.122.0のまま、日本語変更履歴に今回分を追記した。

### 関係する自己確認（重複を除き10件成功、失敗/skip 0）

| 対象 | 件数 | 証拠 |
| --- | ---: | --- |
| 新規：遅延した本物の添付編集GET＋saved/unknown・prepared/unknownから同画面で同op再開 | 2 | m1-ui-final.log、m1-ui-saved.json / m1-ui-prepared.json |
| 新規：実UIのターミナル→会話、新しい編集を閉じた後、別操作による最新queue更新 | 3 | m1-ui-final.log、m1-ui-navigation.json / m1-ui-newer.json / m1-ui-changed.json |
| 影響：既存の暗色1280/明色390の担当・添付編集→退避 | 2 | m1-ui-final.log |
| 影響：元R1の拒否後編集/取消、元R2の遅延absentとsaved/preparedの同op復旧 | 3 | m1-ui-final.log |

```sh
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper M1' hub/test/queue-retreat-ui.test.js
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper R1|Chrome wrapper R2|Chrome wrapper merge' hub/test/queue-retreat-ui.test.js
env -u HUB_TEST_CHROME TMPDIR=/private/tmp HUB_LANG=ja node --test --test-force-exit --test-name-pattern='Chrome wrapper M1|Chrome wrapper R1|Chrome wrapper R2|Chrome wrapper merge' hub/test/queue-retreat-ui.test.js
node --check hub/public/app.js
node --check hub/test/queue-retreat-ui.test.js
git diff --check
```

初回の新規5件と既存影響5件はともに成功（m1-ui-first.log / m1-ui-regression.log）。エラー応答にも最新queueの照合を適用し、ボタン以外のクリックでは取得を取り消さない微調整後、関係10件だけを最終再実行して全成功。最終10件を一度だけ集計し、初回成功分や過去78/226/29/3件、独立確認の不具合再現を合算していない。今回は途中失敗なし。

専用Chrome wrapperを追加指定なしで使用。暗色1280/明色390の保留/完了4枚を `m1-*.png` に保存し、暗色保留と明色スマホ完了を実見した。新規ケースはsend/sendQueuedを拒否、fixture全体はPATH先頭の拒否CLIを使用。通常送信/委任・配送/CLI起動試行・ブラウザー例外は0。savedケースの台帳項目1/preparedケースの項目0の保留から、再読み込みなし・同opのPOST2回で項目1/完了になる。本文、台帳画像の原本、元画像、別queueを保持し、保留中の編集/取消をサーバーでも拒否する。

影響する既存のJSON/PNGは、再生成前のものを `m1-prior-evidence/` と `m1-first-pass-evidence/` に原文保全。構文2件・差分空白・4.122.0のpackage/lock整合、変更範囲と固定本体の状態は `m1-static.json` / `m1-verification.json` に記録する。保存先commit/treeも同JSONと既存本作業の成果へ記録する。

今回の修正は保存/権限/配送に変更のない画面修正で、最新の人の確認方針に従って自己確認で完了する。独立確認を再委任せず、新候補を人へ直接報告する。本体取り込み/再起動、実待ち列の移動/取消、実台帳保存、push/公開、実auto-on、繁体字の更新/専用検証は未実施。本体取り込みと再起動は人の操作。以前の合成データからの実Codex誤起動1回は、今回の起動0とは分けて記録を保持する。
