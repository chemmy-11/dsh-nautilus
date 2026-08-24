#!/bin/bash
# @dsh-external/dsh-xuegu-observation — bash 兼容壳（构建逻辑在 prepare.mjs）。
set -euo pipefail
exec node "$(dirname "$0")/prepare.mjs"
