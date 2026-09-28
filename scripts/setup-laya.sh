#!/bin/sh
set -eu
command -v uv >/dev/null 2>&1 || { echo 'Install uv first to set up the local Laya router.' >&2; exit 1; }
LAYA_DIR="${HOME}/.local/share/bmo/laya"
uv venv "$LAYA_DIR" --python 3.12
uv pip install --python "$LAYA_DIR/bin/python" 'laya-mlx==0.2.0'
"$LAYA_DIR/bin/python" - <<'PY'
import laya_mlx as laya
agent = laya.load('aac6fef/laya-mlx', revision='20aed815fc6acde75733882e7ec0e3f28aeb9717')
result = agent.predict('Hello', {'route': {'type':'choice','instructions':'Select the requested action','criteria':['conversation','coding']}})
assert result['answers']['route']['choice'] in {'conversation','coding'}
print('Local Laya router is ready.')
PY
