#!/usr/bin/env python3
"""Serve the reader and a fixed Kokoro proxy on loopback; stdlib only.

This does not install/download/start Kokoro. Start that service separately.
"""
import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request

ROOT = Path(__file__).resolve().parents[2]
VOICES = {"af_heart", "af_bella", "af_nicole", "am_michael", "bm_george", "bf_emma"}
STATIC_ROOTS = {"js", "css", "vendor", "brand", "docs"}
STATIC_FILES = {"index.html", "icon.svg", "embed.js", "sw.js", "manifest.webmanifest"}
MAX_RESPONSE = 30_000_000


class ReaderHandler(SimpleHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _valid_host(self):
        port = self.server.server_port
        return self.headers.get("Host") in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _safe_static(self):
        if not self._valid_host():
            self._json(403, {"error": "Open this reader through its loopback address."})
            return False
        path = parse.unquote(parse.urlsplit(self.path).path).strip("/") or "index.html"
        parts = Path(path).parts
        if any(part.startswith(".") or part == ".." for part in parts):
            self.send_error(404)
            return False
        target = (ROOT / path).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file() or not (path in STATIC_FILES or parts[0] in STATIC_ROOTS):
            self.send_error(404)
            return False
        return True

    def do_GET(self):
        if self._safe_static():
            super().do_GET()

    def do_HEAD(self):
        if self._safe_static():
            super().do_HEAD()

    def do_POST(self):
        if not self._valid_host():
            self._json(403, {"error": "Invalid loopback host."})
            return
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers['Host']}":
            self._json(403, {"error": "Voice requests must come from this local reader."})
            return
        if self.path != "/local-voice/dev/captioned_speech":
            self._json(404, {"error": "Unknown voice route."})
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            self._json(415, {"error": "Send an application/json request."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 16_000:
                self._json(413, {"error": "Prepare a shorter passage."})
                return
            payload = json.loads(self.rfile.read(size))
            text, voice = payload.get("input"), payload.get("voice")
            if not isinstance(text, str) or not text.strip() or len(text) > 2000 or voice not in VOICES:
                self._json(400, {"error": "Choose an English voice and a passage of at most 2000 characters."})
                return
            # Deliberately expose only speech, never backend debug/file routes.
            body = json.dumps({"model": "kokoro", "input": text, "voice": voice, "speed": 1.0,
                               "response_format": "mp3", "stream": False, "return_timestamps": True,
                               "normalization_options": {"normalize": False}}).encode()
            upstream = request.Request(f"http://127.0.0.1:{self.server.voice_port}/dev/captioned_speech",
                                       data=body, headers={"Content-Type": "application/json"})
            # Ignore system proxy configuration and refuse redirects away
            # from the explicitly chosen local TTS service.
            class NoRedirect(request.HTTPRedirectHandler):
                def redirect_request(self, *_args, **_kwargs):
                    return None
            opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
            with opener.open(upstream, timeout=180) as response:
                raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    self._json(502, {"error": "The voice response was too large."})
                    return
                result = json.loads(raw)
                if not isinstance(result, dict) or not isinstance(result.get("audio"), str):
                    self._json(502, {"error": "Kokoro returned no audio."})
                    return
                self._json(200, {key: result.get(key) for key in ("audio", "audio_format", "timestamps")})
        except (ValueError, TypeError, AttributeError):
            self._json(400, {"error": "Invalid voice request or response."})
        except (error.URLError, TimeoutError, OSError):
            self._json(502, {"error": "Start Kokoro-FastAPI on loopback port " + str(self.server.voice_port) + " and try again."})

    def log_message(self, fmt, *args):
        # Do not log POST text or URL query strings.
        print(f"Reader helper: {self.command} {parse.urlsplit(self.path).path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--voice-port", type=int, default=8880)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535 or not 1024 <= args.voice_port <= 65535:
        parser.error("Use ports between 1024 and 65535.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(ReaderHandler, directory=str(ROOT)))
    server.voice_port = args.voice_port
    print(f"Reader: http://127.0.0.1:{args.port}/")
    print(f"Voice proxy: fixed to http://127.0.0.1:{args.voice_port}/ (start Kokoro separately)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
