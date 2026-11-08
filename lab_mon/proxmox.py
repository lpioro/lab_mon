from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener
import ipaddress
import json
import re
import ssl
import time
from threading import Lock

from .config import Source


class APIError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Proxmox:
    def __init__(self, source: Source, timeout: int):
        self.source = source
        self.timeout = timeout
        context = ssl.create_default_context()
        if source.ca_file:
            context.load_verify_locations(cafile=source.ca_file)
        self.opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=context))

    def get(self, path: str, expected: type):
        request = Request(self.source.url + "/api2/json" + path, headers={
            "Accept": "application/json",
            "Authorization": f"PVEAPIToken={self.source.token_id}={self.source.token_secret}",
        })
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                data = json.loads(response.read(8 * 1024 * 1024))["data"]
            if not isinstance(data, expected):
                raise ValueError
            return data
        except HTTPError as error:
            status = error.code
            error.close()
            raise APIError(f"Proxmox zwrócił HTTP {status}.") from None
        except (URLError, TimeoutError, OSError):
            raise APIError("Połączenie z Proxmoxem nie powiodło się. Sprawdź sieć i zaufanie TLS.") from None
        except (ValueError, KeyError, TypeError):
            raise APIError("Proxmox zwrócił nieoczekiwaną odpowiedź.") from None

    def node_metrics(self):
        return self.get("/cluster/resources?type=node", list)

    def inventory(self, read_networks: bool):
        resources = self.get("/cluster/resources", list)
        nodes = []
        guests = []
        for row in resources:
            if not isinstance(row, dict) or not isinstance(row.get("node"), str):
                continue
            resource_type = row.get("type")
            stats = {field: row.get(field) for field in ("status", "cpu", "mem", "maxmem", "uptime")}
            if resource_type == "node":
                nodes.append({"name": row["node"], "ip": None, **stats})
            elif resource_type in ("lxc", "qemu") and type(row.get("vmid")) is int:
                guests.append({
                    "node": row["node"], "vmid": row["vmid"], "kind": resource_type,
                    "name": row.get("name") or str(row["vmid"]), **stats,
                })

        try:
            cluster_status = self.get("/cluster/status", list)
            addresses = {row.get("name"): ip_value(row.get("ip")) for row in cluster_status
                         if isinstance(row, dict) and row.get("type") == "node"}
        except APIError:
            addresses = {}
        for node in nodes:
            node["ip"] = addresses.get(node["name"])

        if read_networks and guests:
            with ThreadPoolExecutor(max_workers=min(6, len(guests))) as pool:
                guests = list(pool.map(self.guest_networks, guests))
        else:
            for guest in guests:
                guest.update(networks=[], network_state="Wyłączone w konfiguracji")
        return sorted(nodes, key=lambda node: node["name"]), sorted(guests, key=lambda guest: guest["vmid"])

    def guest_networks(self, guest: dict):
        node = quote(guest["node"], safe="")
        path = f"/nodes/{node}/{guest['kind']}/{guest['vmid']}/config"
        try:
            config = self.get(path, dict)
        except APIError:
            return {**guest, "networks": [], "network_state": "Konfiguracja sieci niedostępna"}
        networks = []
        for key in sorted(config):
            if not re.fullmatch(r"net\d+", key):
                continue
            interface = parse_options(config[key])
            ip_options = interface if guest["kind"] == "lxc" else parse_options(config.get("ipconfig" + key[3:]))
            networks.append({
                "name": interface.get("name", key),
                "bridge": interface.get("bridge"),
                "vlan": interface.get("tag"),
                "ipv4": ip_value(ip_options.get("ip")),
                "ipv6": ip_value(ip_options.get("ip6")),
                "gateway": ip_value(ip_options.get("gw")),
                "gateway6": ip_value(ip_options.get("gw6")),
            })
        return {**guest, "networks": networks, "network_state": "Odczytano konfigurację"}


def parse_options(value):
    if not isinstance(value, str):
        return {}
    return dict(part.split("=", 1) for part in value.split(",") if "=" in part)


def ip_value(value):
    if not isinstance(value, str):
        return None
    if value in ("dhcp", "auto", "manual"):
        return value
    try:
        return str(ipaddress.ip_interface(value)) if "/" in value else str(ipaddress.ip_address(value))
    except ValueError:
        return None


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class Snapshot:
    def __init__(self, settings):
        self.settings = settings
        self.lock = Lock()
        self.last_poll = float("-inf")
        self.cache = {}
        self.clients = {}
        for source in settings.sources:
            try:
                self.clients[source.id] = Proxmox(source, settings.timeout)
            except (ssl.SSLError, OSError):
                self.clients[source.id] = None

    def get(self):
        with self.lock:
            if time.monotonic() - self.last_poll >= self.settings.dashboard["refresh_seconds"]:
                self.refresh()
            data = {
                "dashboard": self.settings.dashboard, "sources": list(self.cache.values()),
                "services": self.settings.services, "source_configuration": self.settings.source_configuration,
            }
            if self.settings.dashboard["demo"]:
                return demo_snapshot(data)
            if not self.settings.dashboard["show_addresses"]:
                return without_addresses(data)
            return data

    def refresh(self):
        for source in self.settings.sources:
            client = self.clients[source.id]
            prior = self.cache.get(source.id, {"nodes": [], "guests": [], "collected_at": None})
            try:
                if client is None:
                    raise APIError("Nie można wczytać certyfikatu CA tego źródła.")
                nodes, guests = client.inventory(self.settings.read_guest_networks)
                self.cache[source.id] = {
                    "id": source.id, "label": source.label, "nodes": nodes, "guests": guests,
                    "collected_at": timestamp(), "error": None,
                }
            except APIError as error:
                self.cache[source.id] = {**prior, "id": source.id, "label": source.label, "error": str(error)}
        self.last_poll = time.monotonic()


def without_addresses(data):
    hidden_keys = ("ipv4", "ipv6", "gateway", "gateway6")
    sources = []
    for source in data["sources"]:
        nodes = [{**node, "ip": None} for node in source["nodes"]]
        guests = []
        for guest in source["guests"]:
            networks = [{**network, **dict.fromkeys(hidden_keys)} for network in guest["networks"]]
            guests.append({**guest, "networks": networks})
        sources.append({**source, "nodes": nodes, "guests": guests})
    return {
        **data, "sources": sources,
        "services": [{**service, "endpoint": ""} for service in data["services"]],
        "source_configuration": [{**source, "url": ""} for source in data["source_configuration"]],
    }


def demo_snapshot(data):
    nodes = [{"name": "demo-a", "ip": "192.0.2.10", "status": "online", "cpu": 0.12},
             {"name": "demo-b", "ip": "192.0.2.11", "status": "online", "cpu": 0.04}]
    guests = [
        {"node": "demo-a", "vmid": 900, "kind": "lxc", "name": "demo-app", "status": "running",
         "cpu": 0.06, "mem": 268435456, "maxmem": 1073741824, "network_state": "Dane demonstracyjne",
         "networks": [{"name": "eth0", "bridge": "vmbr0", "ipv4": "192.0.2.50/24", "gateway": "192.0.2.1"}]},
        {"node": "demo-b", "vmid": 901, "kind": "qemu", "name": "demo-db", "status": "stopped",
         "network_state": "Dane demonstracyjne", "networks": [{"name": "net0", "bridge": "vmbr1", "ipv4": "dhcp"}]},
    ]
    snapshot = {**data, "sources": [{"id": "demo", "label": "Źródło demonstracyjne", "nodes": nodes,
                                     "guests": guests, "collected_at": timestamp(), "error": None}],
                "services": [{"source": "demo", "vmid": 900, "name": "Demo HTTP", "endpoint": "demo.example.invalid:8080",
                              "depends_on": ["demo-db"], "note": "Przykładowy wpis konfiguracyjny."}]}
    return snapshot if data["dashboard"]["show_addresses"] else without_addresses(snapshot)
