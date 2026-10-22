#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
node test/paid-license-acceptance.cjs
HUB_PAID_CHECK_EXIT=$?
printf '\n確認結果を読んだら Enter を押してください：'
read -r HUB_PAID_CHECK_DONE
exit "$HUB_PAID_CHECK_EXIT"
