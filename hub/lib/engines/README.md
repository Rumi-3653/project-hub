# 実行の接続と共通の確認

サーバー内に残っていた3つの仕組みの接続処理です。実行・保存・上限証拠・実行権を管理する既存部品へ、そのまま渡します。

| 部品 | 担当 | 既存の本体 |
| --- | --- | --- |
| queue | 会話実行と終了後の順番進行、退避、内部/人の依頼の配送 | chat、chat-continuation、request-delivery、queue-retreat |
| limit-switch | 私有policyへの接続、上限証拠の取得、端末の交代資料と開始前の再確認 | model-limits、terminal-limits、limit-route、私有limit_switch |
| parallel | 停止snapshotと手動ticket、権利、同じ場所の排他、端末の実行権 | stop-control、license、execution-gate |

作成時に渡す既存参照はそのまま使い、後から初期化/交換される値は `get...` を元の参照位置で呼びます。作成関数内でgetterを先読みしません。サーバー内の薄い呼出関数は宣言の巻き上げを保ちます。私有policy、ChatRunner、端末hookとタイマーの設置は元と同じ位置で実行し、状態や実行周期を増やしません。

HTTPの共通guard、本文/世代、履歴lease、停止・再起動の共通受付はサーバーに残します。人の手動待ち、停止、無料の内部依頼、終了保存を既存の規則のまま保ちます。私有部品を追加で読み込まず、利用可能な版の差し込みを既存extensionsへ任せます。
