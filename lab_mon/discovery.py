from concurrent.futures import ThreadPoolExecutor
from ipaddress import ip_interface
import socket
from threading import Thread
import time

from .proxmox import timestamp


MAX_ADDRESSES = 64
PORT_HINTS = {
    22: "SSH", 80: "HTTP", 443: "HTTPS", 1883: "MQTT", 3306: "MySQL / MariaDB",
    5432: "PostgreSQL", 5678: "n8n", 6052: "ESPHome", 8006: "Proxmox",
    8080: "HTTP", 8123: "Home Assistant", 8443: "HTTPS", 8883: "MQTT przez TLS",
}


def inventory_targets(sources, networks):
    targets = {}
    limit_reached = False
    for source in sources:
        if source["error"]:
            continue
        for guest in source["guests"]:
            if guest["status"] != "running":
                continue
            owner = {"source": source["label"], "name": guest["name"],
                     "kind": guest["kind"], "vmid": guest["vmid"], "node": guest["node"]}
            for network in guest["networks"]:
                for value in (network.get("ipv4"), network.get("ipv6")):
                    try:
                        address = ip_interface(value).ip
                    except ValueError:
                        continue
                    if not any(address.version == allowed.version and address in allowed for allowed in networks):
                        continue
                    if address not in targets and len(targets) == MAX_ADDRESSES:
                        limit_reached = True
                        continue
                    owners = targets.setdefault(address, [])
                    if owner not in owners:
                        owners.append(owner)
    return targets, limit_reached


def probe(target):
    address, port = target
    family = socket.AF_INET if address.version == 4 else socket.AF_INET6
    try:
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(0.75)
            client.connect((str(address), port))
        return True
    except OSError:
        return False


def initial_result(enabled):
    return {
        "enabled": enabled, "demo": False, "scanned_at": None, "addresses": 0,
        "source_errors": 0, "limit_reached": False, "services": [],
    }


class Discovery:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.settings = snapshot.settings.discovery
        self.result = initial_result(True)

    def start(self):
        Thread(target=self.run, name="proxmox-discovery", daemon=True).start()

    def run(self):
        while True:
            started = time.monotonic()
            self.result = self.scan()
            time.sleep(max(1, self.settings.interval_seconds - (time.monotonic() - started)))

    def scan(self):
        inventory = self.snapshot.get(include_hidden_addresses=True)
        sources = inventory["sources"]
        targets, limit_reached = inventory_targets(sources, self.settings.cidrs)
        checks = [(address, port) for address in targets for port in self.settings.ports]
        services = []
        if checks:
            with ThreadPoolExecutor(max_workers=8) as pool:
                for (address, port), opened in zip(checks, pool.map(probe, checks)):
                    if not opened:
                        continue
                    for owner in targets[address]:
                        services.append({
                            **owner, "address": str(address) if inventory["dashboard"]["show_addresses"] else None,
                            "port": port, "hint": PORT_HINTS.get(port),
                        })
        return {
            "enabled": True, "demo": False, "scanned_at": timestamp(),
            "addresses": len(targets), "limit_reached": limit_reached, "services": services,
            "source_errors": sum(bool(source["error"]) for source in sources),
        }


def demo_discovery(show_addresses):
    return {
        **initial_result(True), "demo": True, "scanned_at": timestamp(), "addresses": 1,
        "services": [{
            "source": "Źródło demonstracyjne", "name": "demo-app", "kind": "lxc", "vmid": 900,
            "node": "demo-a", "address": "192.0.2.50" if show_addresses else None,
            "port": 8080, "hint": "HTTP",
        }],
    }
