import argparse
import json
import os
from pathlib import Path
import sys
import tomllib

from waitress import serve

from .config import load_settings
from .proxmox import Snapshot


ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/bootstrap.min.css": ("bootstrap.min.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/mark.svg": ("mark.svg", "image/svg+xml"),
}


def create_app(snapshot):
    static = Path(__file__).parent / "static"

    def app(environ, start_response):
        path = environ["PATH_INFO"]
        status = "200 OK"
        content_type = "text/plain; charset=utf-8"
        if environ["REQUEST_METHOD"] not in ("GET", "HEAD"):
            status, body = "405 Method Not Allowed", b"Method not allowed"
        elif path == "/healthz":
            body = b"ok"
        elif path == "/api/snapshot":
            content_type = "application/json; charset=utf-8"
            body = json.dumps(snapshot.get(), ensure_ascii=False).encode()
        elif path in ASSETS:
            filename, content_type = ASSETS[path]
            body = (static / filename).read_bytes()
        else:
            status, body = "404 Not Found", b"Not found"

        headers = [
            ("Content-Type", content_type), ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
            ("X-Robots-Tag", "noindex, nofollow"), ("Referrer-Policy", "no-referrer"),
            ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"),
        ]
        if status.startswith("405"):
            headers.append(("Allow", "GET, HEAD"))
        start_response(status, headers)
        return [b"" if environ["REQUEST_METHOD"] == "HEAD" else body]

    return app


def main():
    parser = argparse.ArgumentParser(description="Lab Mon · dashboard Proxmoxa")
    parser.add_argument("--config", type=Path, default=os.getenv("LAB_MON_CONFIG", "config.toml"))
    parser.add_argument("--host", default=os.getenv("LAB_MON_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.getenv("LAB_MON_PORT", "8080"))
    parser.add_argument("--demo", action="store_true", help="Dane fikcyjne, bez połączenia z Proxmoxem")
    args = parser.parse_args()
    try:
        settings = load_settings(args.config, demo=args.demo)
    except FileNotFoundError:
        sys.exit("Brak pliku konfiguracji. Skopiuj config.example.toml lub użyj --demo.")
    except (tomllib.TOMLDecodeError, KeyError, TypeError, AttributeError, OSError):
        sys.exit("Nie można wczytać konfiguracji. Porównaj plik z config.example.toml.")
    except ValueError as error:
        sys.exit(str(error))
    serve(create_app(Snapshot(settings)), host=args.host, port=args.port, ident="Lab Mon")


if __name__ == "__main__":
    main()
