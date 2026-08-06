#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从用户检索文本中抽取材料领域实体（MatSciBERT NER，依赖 E:\\15w\\pipeline.py 与同目录模型）。

协议（--serve 常驻模式）：
  stdin 每行一条 JSON：{"text": "用户问题或合并上下文…"}
  stdout 每行一条 JSON：{"ok": true, "suffix": "英文实体拼接…"} 或 {"ok": false, "error": "…"}
  模型加载完成后先发一行：{"ready": true}

环境变量：
  MATSCI_PIPELINE_ROOT  默认 E:\\15w，须含 pipeline.py、vocab_mappings.txt、models/MatSciBERT/…
  MATSCI_NER_NO_CRF     默认 1（跳过 CRF，加载更快；设为 0 使用完整 CRF 权重）

单次调试：python matsci_query_entities.py --once '{"text":"stainless steel corrosion"}'
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("MATSCI_PIPELINE_ROOT", r"E:\15w")).expanduser().resolve()
MAX_IN_CHARS = 12_000
MAX_SUFFIX_CHARS = 900


def _silence_pipeline_loggers(pl) -> None:
    for name in ("pipeline", "__main__", ""):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.setLevel(logging.CRITICAL)
        lg.propagate = False
    if hasattr(pl, "log"):
        pl.log.handlers.clear()
        pl.log.addHandler(logging.NullHandler())
        pl.log.setLevel(logging.CRITICAL)


def _load_engine():
    os.chdir(str(ROOT))
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    import pipeline as pl  # noqa: E402

    _silence_pipeline_loggers(pl)
    ner_path = pl.NER_MODEL_PATH if pl.NER_MODEL_PATH.exists() else None
    if ner_path is None:
        alt = pl.MODEL_DIR / "MatSciBERT" / "ner" / "models" / "matscholar"
        if alt.exists():
            ner_path = alt
    no_crf = os.environ.get("MATSCI_NER_NO_CRF", "1").strip() != "0"
    return pl.MatSciBERTNER(model_path=ner_path, no_crf=no_crf)


def _entities_to_suffix(entities: dict) -> str:
    """去重、截断，拼成可拼进检索 query 的英文短语串。"""
    seen: set[str] = set()
    parts: list[str] = []
    order = ("MAT", "PRO", "APL", "SMT", "CMT", "DSC", "SPL")
    for key in order:
        vals = entities.get(key) or []
        if not isinstance(vals, list):
            continue
        for v in vals:
            s = " ".join(str(v).split()).strip()
            if len(s) < 2 or len(s) > 120:
                continue
            low = s.lower()
            if low in seen:
                continue
            seen.add(low)
            parts.append(s)
            if len("; ".join(parts)) >= MAX_SUFFIX_CHARS:
                return "; ".join(parts)[:MAX_SUFFIX_CHARS]
    return "; ".join(parts)[:MAX_SUFFIX_CHARS]


def _handle_line(engine, line: str) -> dict:
    line = line.strip()
    if not line:
        return {"ok": False, "error": "empty_line"}
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"json: {e}"}
    text = str(req.get("text") or "")[:MAX_IN_CHARS].strip()
    if len(text) < 4:
        return {"ok": True, "suffix": ""}
    try:
        ent = engine.extract_entities(text)
        suf = _entities_to_suffix(ent)
        return {"ok": True, "suffix": suf, "entities": ent}
    except Exception as e:
        return {"ok": False, "error": str(e)[:500]}


def serve() -> None:
    if not (ROOT / "pipeline.py").is_file():
        print(
            json.dumps(
                {"ready": False, "error": f"未找到 pipeline.py：{ROOT}"},
                ensure_ascii=False,
            ),
            flush=True,
        )
        sys.exit(1)
    try:
        engine = _load_engine()
    except Exception as e:
        print(
            json.dumps({"ready": False, "error": str(e)}, ensure_ascii=False),
            flush=True,
        )
        sys.exit(1)
    print(json.dumps({"ready": True}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        out = _handle_line(engine, line)
        print(json.dumps(out, ensure_ascii=False), flush=True)


def once(argv: str) -> None:
    if not (ROOT / "pipeline.py").is_file():
        print(json.dumps({"ok": False, "error": f"no pipeline.py at {ROOT}"}, ensure_ascii=False))
        sys.exit(1)
    engine = _load_engine()
    out = _handle_line(engine, argv)
    print(json.dumps(out, ensure_ascii=False))


def main() -> None:
    if "--serve" in sys.argv:
        serve()
        return
    if "--once" in sys.argv:
        idx = sys.argv.index("--once")
        payload = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else '{"text":""}'
        once(payload)
        return
    print(
        json.dumps(
            {"ok": False, "error": "use --serve (stdio RPC) or --once '{\"text\":...}'"},
            ensure_ascii=False,
        )
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
