#!/usr/bin/env python3

from __future__ import annotations

import base64
import json
import sys

IMPERSONATE = "chrome"


DROP_REQUEST_HEADERS = {"host", "content-length", "connection", "accept-encoding"}


DROP_RESPONSE_HEADERS = {"content-encoding", "transfer-encoding", "connection"}


def main() -> int:
    try:
        from curl_cffi import requests
    except ImportError:
        sys.stderr.write(
            "curl_cffi is not installed. Install it with:\n"
            "    python3 -m pip install --user curl_cffi\n"
        )
        return 2

    session = requests.Session(impersonate=IMPERSONATE)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as exc:
            _write({"id": None, "error": f"bad request line: {exc}"})
            continue
        if request.get("method") == "__quit__":
            break

        request_id = request.get("id")
        try:
            headers = {
                name: value
                for name, value in (request.get("headers") or {}).items()
                if name.lower() not in DROP_REQUEST_HEADERS
            }
            body = request.get("body")
            if isinstance(body, str):
                body = base64.b64decode(body)

            response = session.request(
                method=request.get("method", "GET"),
                url=request["url"],
                headers=headers,
                data=body,
                timeout=request.get("timeout", 30),
                allow_redirects=request.get("redirects", True),
            )
            _write(
                {
                    "id": request_id,
                    "status": response.status_code,
                    "headers": {
                        name: value
                        for name, value in response.headers.items()
                        if name.lower() not in DROP_RESPONSE_HEADERS
                    },
                    "body": base64.b64encode(response.content).decode("ascii"),
                }
            )
        except Exception as exc:
            _write({"id": request_id, "error": f"{type(exc).__name__}: {exc}"})

    return 0


def _write(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
