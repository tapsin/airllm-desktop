#!/usr/bin/env python3
"""OpenAI-compatible HTTP API for an AirLLM model.

Example:
  python airllm_openai_server.py --model Qwen/Qwen2.5-7B-Instruct --port 8000
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import threading
import time
import uuid
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Hugging Face model ID or local model directory")
    parser.add_argument("--host", default="127.0.0.1", help="Set to 0.0.0.0 to allow LAN access")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--trust-remote-code", action="store_true", help="Allow Python code provided by the model repo")
    parser.add_argument("--compression", choices=("4bit", "8bit"), help="Optional AirLLM compression; requires bitsandbytes")
    parser.add_argument("--layer-shards", help="Optional directory for AirLLM's converted layer shards")
    return parser.parse_args()


args = parse_args()

# Import server/model dependencies only after argument parsing, so --help is usable
# even before the dependencies have been installed.
try:
    import torch
    import uvicorn
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse, StreamingResponse
    from pydantic import BaseModel, Field
    from airllm import AutoModel
    from transformers import TextIteratorStreamer
except ImportError as exc:
    raise SystemExit(
        "Eksik paket var. Aynı Python ortamında şu komutu çalıştırın:\n"
        "  pip install airllm fastapi uvicorn"
    ) from exc

options: dict[str, Any] = {}
if args.compression:
    options["compression"] = args.compression
if args.layer_shards:
    options["layer_shards_saving_path"] = args.layer_shards

print(f"Model yükleniyor: {args.model} (ilk açılışta indirme/dönüştürme sürebilir)", flush=True)
# AirLLM's AutoModel owns tokenizer/config loading; trust_remote_code is not
# accepted by every AirLLM model class. Keep this switch for compatibility by
# loading the tokenizer explicitly and attaching it to the AirLLM model.
model = AutoModel.from_pretrained(args.model, **options)
if args.trust_remote_code:
    from transformers import AutoTokenizer
    model.tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
tokenizer = model.tokenizer
print("Model hazır.", flush=True)

app = FastAPI(title="AirLLM OpenAI Compatible API", version="1.0.0")
generation_lock = threading.Lock()
activity_lock = threading.Lock()
activity: dict[str, Any] = {
    "state": "ready", "message": "Model hazır; istek bekleniyor.", "updated_at": time.time()
}


def set_activity(state: str, message: str) -> None:
    with activity_lock:
        activity.update(state=state, message=message, updated_at=time.time())


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[Message]
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: int = Field(default=512, ge=1)
    top_p: float = Field(default=0.9, gt=0, le=1)
    stream: bool = False


def make_prompt(messages: list[Message]) -> str:
    conversation = [{"role": item.role, "content": item.content} for item in messages]
    if getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(conversation, tokenize=False, add_generation_prompt=True)
    return "\n".join(f"{item.role.upper()}: {item.content}" for item in messages) + "\nASSISTANT:"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": args.model}


@app.get("/status")
def get_status() -> dict[str, Any]:
    with activity_lock:
        return dict(activity)


@app.post("/admin/shutdown")
def shutdown_server() -> dict[str, str]:
    # This endpoint is only exposed on the configured API bind address. The
    # desktop app binds to loopback, so its Stop button can gracefully stop
    # either a managed or an externally launched local AirLLM process.
    threading.Timer(0.25, lambda: os.kill(os.getpid(), signal.SIGINT)).start()
    return {"status": "shutting_down"}


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {"object": "list", "data": [{"id": args.model, "object": "model", "owned_by": "local"}]}


@app.post("/v1/chat/completions")
def chat_completions(request: ChatRequest):
    if not request.messages:
        raise HTTPException(status_code=400, detail="messages boş olamaz")
    try:
        set_activity("generating", "İstek alındı; model yanıt hazırlıyor.")
        prompt = make_prompt(request.messages)
        encoded = tokenizer(
            [prompt], return_tensors="pt", return_attention_mask=False,
            truncation=True, padding=False,
        )
        input_ids = encoded["input_ids"]
        input_length = input_ids.shape[-1]
        generation: dict[str, Any] = {
            "max_new_tokens": min(request.max_tokens, args.max_new_tokens),
            "use_cache": True,
            "return_dict_in_generate": True,
        }
        if request.temperature > 0:
            generation.update(do_sample=True, temperature=request.temperature, top_p=request.top_p)
        else:
            generation["do_sample"] = False

        if request.stream:
            stream_id = "chatcmpl-" + uuid.uuid4().hex[:24]
            created = int(time.time())
            model_name = request.model or args.model
            streamer = TextIteratorStreamer(
                tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=600
            )

            def generate_stream() -> None:
                try:
                    with generation_lock, torch.inference_mode():
                        model.generate(input_ids, streamer=streamer, **generation)
                except Exception as exc:
                    print(f"Streaming generation failed: {exc}", flush=True)
                    set_activity("error", f"Yanıt üretimi başarısız: {exc}")
                    # Wake the response iterator if generation errored before
                    # Transformers could close the streamer itself.
                    try:
                        streamer.end()
                    except Exception:
                        pass

            worker = threading.Thread(target=generate_stream, daemon=True)
            worker.start()

            def events():
                role_chunk = {
                    "id": stream_id, "object": "chat.completion.chunk", "created": created,
                    "model": model_name,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                }
                yield "data: " + json.dumps(role_chunk, ensure_ascii=False) + "\n\n"
                for text_chunk in streamer:
                    if text_chunk:
                        set_activity("generating", "Yanıt üretiliyor ve Open WebUI’ye aktarılıyor.")
                        chunk = {
                            "id": stream_id, "object": "chat.completion.chunk", "created": created,
                            "model": model_name,
                            "choices": [{"index": 0, "delta": {"content": text_chunk}, "finish_reason": None}],
                        }
                        yield "data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n"
                worker.join()
                set_activity("ready", "Yanıt tamamlandı; yeni istek bekleniyor.")
                final_chunk = {
                    "id": stream_id, "object": "chat.completion.chunk", "created": created,
                    "model": model_name,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                yield "data: " + json.dumps(final_chunk, ensure_ascii=False) + "\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(events(), media_type="text/event-stream", headers={
                "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no",
            })

        with generation_lock, torch.inference_mode():
            result = model.generate(input_ids, **generation)
        sequences = result.sequences
        answer_tokens = sequences[0][input_length:]
        answer = tokenizer.decode(answer_tokens, skip_special_tokens=True).strip()
        set_activity("ready", "Yanıt tamamlandı; yeni istek bekleniyor.")
    except Exception as exc:
        set_activity("error", f"Yanıt üretimi başarısız: {exc}")
        raise HTTPException(status_code=500, detail=f"Üretim hatası: {exc}") from exc

    completion_tokens = int(answer_tokens.shape[-1])
    return JSONResponse({
        "id": "chatcmpl-" + uuid.uuid4().hex[:24],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": request.model or args.model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": int(input_length), "completion_tokens": completion_tokens,
                   "total_tokens": int(input_length) + completion_tokens},
    })


if __name__ == "__main__":
    uvicorn.run(app, host=args.host, port=args.port)
