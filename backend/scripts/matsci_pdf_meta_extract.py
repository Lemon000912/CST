#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF 入库元数据本地抽取：MatSciBERT NER（复用 matscibert-demo/ner.py 的
BERT-BiLSTM-CRF 实现），把 SPL/SMT/DSC/PRO 标签映射为四个入库字段。

协议（一次进程只加载一次模型）：
  stdout 先输出一行 {"ready": true}（加载成功），失败时打印到 stderr 并 exit 1；
  stdin 每行一条 JSON：{"id": "...", "text": "..."}
  stdout 随后逐行回：{"id": "...", "ok": true, "fields": {...}}
                 或  {"id": "...", "ok": false, "error": "..."}
  单条命令：python matsci_pdf_meta_extract.py --selftest

环境变量：
  MATSCI_META_DEMO_DIR     默认 D:\\workTrace\\end\\MatSciBERT\\matscibert-demo
  MATSCI_META_MODEL_DIR    默认 <demo>\\model\\ner_matscholar
  MATSCI_META_DEVICE       默认自动（cuda 可用则 cuda，否则 cpu）
  MATSCI_META_NORMALIZE    默认 0；=1 时每个句子块先做 demo 的 normalize_text
  MATSCI_META_MAX_TEXT_CHARS        默认 120000
  MATSCI_META_MAX_ENTITIES_PER_FIELD 默认 30
  MATSCI_META_MAX_FIELD_CHARS       默认 500
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

DEFAULT_DEMO_DIR = Path(r"D:\workTrace\end\MatSciBERT\matscibert-demo")

FIELD_BY_LABEL = {
    "SPL": "symmetry_phase",
    "SMT": "synthesis_method",
    "DSC": "structure_descriptor",
    "PRO": "properties",
}


def _env_int(name: str, fallback: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
        return value if value > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _demo_dir() -> Path:
    raw = os.environ.get("MATSCI_META_DEMO_DIR", "").strip()
    return Path(raw).resolve() if raw else DEFAULT_DEMO_DIR.resolve()


def _model_dir(demo: Path) -> Path:
    raw = os.environ.get("MATSCI_META_MODEL_DIR", "").strip()
    return Path(raw).resolve() if raw else (demo / "model" / "ner_matscholar").resolve()


def _material_list(demo: Path) -> list:
    """与 matscibert-demo/main.py 相同的 material_dict.json 读取方式。"""
    path = demo / "material_dict.json"
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        materials = data.get("materials", []) if isinstance(data, dict) else []
        return materials if isinstance(materials, list) else []
    except Exception:
        return []


def _split_sentences(text: str) -> list:
    """按句号/换行把正文切成句子；对 NER 分块足够稳健。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    parts = re.split(r"(?<=[.!?])\s+|\s*\n\s*", text)
    return [p.strip() for p in parts if p and p.strip()]


def _hard_split(sentence: str, max_chars: int) -> list:
    """超长单句按字符硬切，交给 extract_entities 的 512 token 截断兜底。"""
    if len(sentence) <= max_chars:
        return [sentence]
    out = []
    start = 0
    while start < len(sentence):
        end = min(start + max_chars, len(sentence))
        if end < len(sentence):
            cut = sentence.rfind(" ", start + max_chars // 2, end)
            if cut > start:
                end = cut
        piece = sentence[start:end].strip()
        if piece:
            out.append(piece)
        start = end
    return out


def _make_chunks(text: str, tokenizer, max_tokens: int = 480) -> list:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    def flush() -> None:
        nonlocal current, current_len
        if current:
            chunks.append(" ".join(current))
        current = []
        current_len = 0

    for sentence in _split_sentences(text):
        token_count = len(tokenizer.encode(sentence, add_special_tokens=False))
        if token_count <= 0:
            continue
        if token_count > max_tokens:
            flush()
            for piece in _hard_split(sentence, max_tokens * 4):
                if current and current_len + len(tokenizer.encode(piece, add_special_tokens=False)) > max_tokens:
                    flush()
                current.append(piece)
                current_len += len(tokenizer.encode(piece, add_special_tokens=False))
            continue
        if current and current_len + token_count > max_tokens:
            flush()
        current.append(sentence)
        current_len += token_count
    flush()
    return chunks


def _aggregate(entities: list, max_entities: int, max_chars: int) -> dict:
    """跨块聚合：大小写去重、保留首次出现顺序，单字段限长，无命中返回 None。"""
    buckets: dict[str, list] = {}
    seen: dict[str, set] = {}
    junk = re.compile(r"^[\W_]+$")
    for item in entities or []:
        label = str(item.get("type") or "").strip().upper()
        field = FIELD_BY_LABEL.get(label)
        if not field:
            continue
        value = str(item.get("entity") or "").replace("#", "").strip()
        if len(value) < 2 or len(value) > 200 or junk.match(value):
            continue
        key = value.lower()
        if key in seen.get(field, set()):
            continue
        seen.setdefault(field, set()).add(key)
        bucket = buckets.setdefault(field, [])
        if len(bucket) < max_entities:
            bucket.append(value)
    result = {}
    for field, values in buckets.items():
        joined = ", ".join(values)
        result[field] = joined[:max_chars] or None
    return {field: result.get(field) for field in FIELD_BY_LABEL.values()}


class NerEngine:
    def __init__(self) -> None:
        demo = _demo_dir()
        model = _model_dir(demo)
        if not (demo / "ner.py").is_file():
            raise FileNotFoundError(f"未找到 matscibert-demo ner.py：{demo}")
        if not (model / "pytorch_model.bin").is_file():
            raise FileNotFoundError(f"未找到 NER 权重：{model}")
        if demo not in [str(p) for p in sys.path]:
            sys.path.insert(0, str(demo))

        import torch

        # 演示工程以 `from torchcrf import CRF` 引入，而本机 PyPI 包名为大写 TorchCRF，
        # 且该 Python 对模块名大小写敏感；这里做一次模块别名桥接，不改 demo 代码。
        try:
            import torchcrf  # noqa: F401
        except ModuleNotFoundError:
            import importlib
            import TorchCRF as torchcrf_module  # type: ignore[import-not-found]

            sys.modules.setdefault("torchcrf", torchcrf_module)

        import ner as demo_ner
        import torch

        requested_device = os.environ.get("MATSCI_META_DEVICE", "").strip().lower()
        if requested_device == "cpu":
            device = "cpu"
        elif requested_device == "cuda":
            device = "cuda"
        else:
            device = "cuda" if torch.cuda.is_available() else "cpu"

        # 老 checkpoint 存了 encoder.bert.embeddings.position_ids，而新 transformers
        # 把它注册为 non-persistent buffer，严格 load_state_dict 会报 unexpected key。
        # 只在这一处对 torch.load 做兼容过滤，demo 代码保持原样。
        from transformers.utils import logging as hf_logging

        hf_logging.set_verbosity_error()
        original_torch_load = torch.load

        def _compat_torch_load(*args, **kwargs):
            state = original_torch_load(*args, **kwargs)
            if isinstance(state, dict):
                state.pop("encoder.bert.embeddings.position_ids", None)
            return state

        torch.load = _compat_torch_load
        try:
            self.model, self.tokenizer, self.config = demo_ner.load_ner_model(device, str(model))
        finally:
            torch.load = original_torch_load
        self.device = device
        self.material_dict = _material_list(demo)
        self.normalize_on = os.environ.get("MATSCI_META_NORMALIZE", "0").strip() == "1"
        self.max_text_chars = _env_int("MATSCI_META_MAX_TEXT_CHARS", 120_000)
        self.max_entities = _env_int("MATSCI_META_MAX_ENTITIES_PER_FIELD", 30)
        self.max_field_chars = _env_int("MATSCI_META_MAX_FIELD_CHARS", 500)
        if self.normalize_on:
            from normalize_text import normalize as matsci_normalize

            self.normalize = matsci_normalize
        else:
            self.normalize = None

    def labels(self) -> list:
        id2label = getattr(self.config, "id2label", None) or {}
        return [str(id2label.get(i, "?")) for i in sorted(int(k) for k in id2label)]

    def extract(self, text: str) -> dict:
        text = str(text or "").strip()[: self.max_text_chars]
        if not text:
            raise ValueError("empty_text")
        demo_ner = sys.modules.get("ner")
        if demo_ner is None:
            raise RuntimeError("ner module not loaded")
        entities: list = []
        for chunk in _make_chunks(text, self.tokenizer):
            chunk_text = self.normalize(chunk) if self.normalize else chunk
            chunk_entities = demo_ner.extract_entities(
                chunk_text,
                self.model,
                self.tokenizer,
                self.config,
                self.material_dict,
                self.device,
            )
            entities.extend(chunk_entities or [])
        return _aggregate(entities, self.max_entities, self.max_field_chars)


def _selftest() -> int:
    engine = NerEngine()
    sample = (
        "Fe3O4 nanoparticles were synthesized by a sol-gel method and annealed at 600 C. "
        "The magnetic properties and cubic spinel structure were characterized by VSM and XRD."
    )
    try:
        fields = engine.extract(sample)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ready": False, "error": str(error)[:500]}, ensure_ascii=False), flush=True)
        return 1
    print(
        json.dumps(
            {
                "ready": True,
                "model_dir": str(_model_dir(_demo_dir())),
                "labels": engine.labels(),
                "fields": fields,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


def _serve() -> int:
    try:
        engine = NerEngine()
    except Exception as error:  # noqa: BLE001
        print(f"[matsci-meta] model load failed: {str(error)[:800]}", file=sys.stderr, flush=True)
        return 1
    print(json.dumps({"ready": True}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            paper_id = req.get("id")
            if paper_id is None:
                raise ValueError("missing id")
            fields = engine.extract(str(req.get("text") or ""))
            print(
                json.dumps({"id": paper_id, "ok": True, "fields": fields}, ensure_ascii=False),
                flush=True,
            )
        except Exception as error:  # noqa: BLE001
            print(
                json.dumps(
                    {
                        "id": req.get("id"),
                        "ok": False,
                        "error": str(error)[:500],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    return _serve()


if __name__ == "__main__":
    sys.exit(main())
