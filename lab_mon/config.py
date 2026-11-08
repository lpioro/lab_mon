from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit
import os
import re
import tomllib


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    url: str
    token_id: str
    token_secret: str = field(repr=False)
    ca_file: str | None


@dataclass(frozen=True)
class HistorySettings:
    enabled: bool = True
    interval_seconds: int = 60
    retention_days: int = 30
    path: Path = Path("data/history.sqlite3")


@dataclass(frozen=True)
class Settings:
    dashboard: dict
    sources: tuple[Source, ...]
    services: list[dict]
    timeout: int
    read_guest_networks: bool
    history: HistorySettings = HistorySettings()
    source_configuration: tuple[dict, ...] = ()


def load_settings(path: Path, *, demo: bool = False) -> Settings:
    raw = tomllib.loads(path.read_text(encoding="utf-8")) if path.is_file() or not demo else {}
    options = raw.get("dashboard", {})
    history_options = raw.get("history", {})
    history_enabled = history_options.get("enabled", True)
    history_interval = history_options.get("interval_seconds", 60)
    history_retention = history_options.get("retention_days", 30)
    if type(history_enabled) is not bool:
        raise ValueError("history.enabled musi mieć wartość true albo false.")
    if type(history_interval) is not int or not 15 <= history_interval <= 3600:
        raise ValueError("history.interval_seconds musi mieć wartość od 15 do 3600.")
    if type(history_retention) is not int or not 1 <= history_retention <= 365:
        raise ValueError("history.retention_days musi mieć wartość od 1 do 365.")
    history = HistorySettings(
        history_enabled, history_interval, history_retention,
        Path(os.environ.get("LAB_MON_HISTORY_DB", "data/history.sqlite3")),
    )
    refresh = options.get("refresh_seconds", 30)
    timeout = options.get("timeout_seconds", 5)
    if type(refresh) is not int or not 5 <= refresh <= 3600:
        raise ValueError("refresh_seconds musi być liczbą całkowitą od 5 do 3600.")
    if type(timeout) is not int or not 1 <= timeout <= 30:
        raise ValueError("timeout_seconds musi być liczbą całkowitą od 1 do 30.")
    theme = options.get("theme", "light")
    if theme not in ("light", "dark"):
        raise ValueError("theme musi mieć wartość light albo dark.")
    default_view = options.get("default_view", "topology")
    if default_view not in ("topology", "table"):
        raise ValueError("default_view musi mieć wartość topology albo table.")
    dashboard = {
        "title": options.get("title", "Lab Mon · Proxmox"),
        "description": options.get("description", "Topologia, adresacja i stan środowiska Proxmox."),
        "refresh_seconds": refresh,
        "timeout_seconds": timeout,
        "read_guest_networks": options.get("read_guest_networks", True),
        "theme": theme,
        "default_view": default_view,
        "show_addresses": options.get("show_addresses", True),
        "demo": demo,
        "history": {
            "enabled": history.enabled,
            "interval_seconds": history.interval_seconds,
            "retention_days": history.retention_days,
        },
    }
    for name in ("show_addresses", "read_guest_networks"):
        if type(options.get(name, True)) is not bool:
            raise ValueError(f"{name} musi mieć wartość true albo false.")
    if not all(isinstance(dashboard[key], str) for key in ("title", "description")):
        raise ValueError("title i description muszą być tekstem.")

    sources = []
    source_configuration = []
    if not demo:
        for index, entry in enumerate(raw.get("proxmox", []), 1):
            source_id = entry["id"]
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", source_id):
                raise ValueError(f"Nieprawidłowe id źródła nr {index}.")
            if any(source.id == source_id for source in sources):
                raise ValueError(f"Powtórzone id źródła nr {index}.")
            url = urlsplit(entry["url"])
            if (url.scheme != "https" or not url.hostname or url.username is not None
                    or url.path not in ("", "/") or url.query or url.fragment):
                raise ValueError(f"Źródło nr {index} wymaga bazowego adresu HTTPS bez ścieżki i danych logowania.")
            try:
                port = url.port
            except ValueError:
                raise ValueError(f"Nieprawidłowy port źródła nr {index}.") from None
            if port == 0:
                raise ValueError(f"Nieprawidłowy port źródła nr {index}.")
            token_id = os.environ.get(entry["token_id_env"], "")
            token_secret = os.environ.get(entry["token_secret_env"], "")
            if (not re.fullmatch(r"[^\s!=]+@[^\s!=]+![^\s!=]+", token_id)
                    or not re.fullmatch(r"[A-Za-z0-9-]+", token_secret)):
                raise ValueError(f"Uzupełnij identyfikator i sekret tokenu w zmiennych środowiskowych źródła nr {index}.")
            configured_ca = entry.get("ca_file")
            ca_file = str((path.parent / configured_ca).resolve()) if configured_ca else None
            label = entry.get("label", source_id)
            if not isinstance(label, str) or not label.strip():
                raise ValueError(f"Etykieta źródła nr {index} musi być tekstem.")
            base_url = entry["url"].rstrip("/")
            sources.append(Source(source_id, label, base_url, token_id, token_secret, ca_file))
            source_configuration.append({
                "id": source_id, "label": label, "url": base_url, "ca_file": configured_ca or "",
                "token_id_env": entry["token_id_env"], "token_secret_env": entry["token_secret_env"],
            })
        if not sources:
            raise ValueError("Dodaj przynajmniej jedno źródło [[proxmox]] lub uruchom tryb --demo.")

    services = []
    for index, entry in enumerate(raw.get("services", []) if not demo else [], 1):
        vmid = entry["vmid"]
        depends_on = entry.get("depends_on", [])
        if (type(vmid) is not int or vmid < 1 or not isinstance(depends_on, list)
                or not all(isinstance(item, str) for item in depends_on)
                or not all(isinstance(entry.get(key, ""), str) for key in ("source", "name", "endpoint", "note"))
                or not entry["name"].strip() or not any(source.id == entry["source"] for source in sources)):
            raise ValueError(f"Nieprawidłowa konfiguracja usługi nr {index}.")
        services.append({
            "source": entry["source"], "vmid": vmid, "name": entry["name"],
            "endpoint": entry.get("endpoint", ""), "depends_on": depends_on, "note": entry.get("note", ""),
        })
    return Settings(dashboard, tuple(sources), services, timeout, options.get("read_guest_networks", True),
                    history, tuple(source_configuration))
