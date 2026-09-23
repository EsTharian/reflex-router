#!/bin/sh
# laya-serve with its `typed-decisions` slot pointed at a local checkpoint directory ($LAYA_CHECKPOINT), for evaluating
# a fine-tuned Laya exactly as reflex would ask it (eval-checkpoint.ts). Runs laya-serve's own app with the Python of
# the installed laya tool; everything else (LAYA_PORT, LAYA_API_KEY, offline mode) comes from the environment as usual.
set -eu
: "${LAYA_CHECKPOINT:?set LAYA_CHECKPOINT to a checkpoint directory}"
bin=$(command -v laya-serve) || { echo "laya-serve is not on PATH" >&2; exit 127; }
bin=$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$bin")
exec "$(dirname "$bin")/python" -c '
import os
from laya import serve
from laya.router import Router

def build_router():
    serve._apply_thread_limit()
    router = Router(models={"typed-decisions": os.environ["LAYA_CHECKPOINT"]}, device=os.environ.get("LAYA_DEVICE") or None)
    router.preload(["typed-decisions"])
    return router

serve.build_router = build_router
serve.main()
'
