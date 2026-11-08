from ipaddress import ip_address
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import Mock, patch

from lab_mon.__main__ import create_app
from lab_mon.config import load_discovery, load_settings
from lab_mon.discovery import Discovery, probe
from lab_mon.proxmox import Snapshot


class DiscoveryTests(unittest.TestCase):
    def test_scope_validation(self):
        for options in (
            {"enabled": True}, {"cidrs": ["0.0.0.0/0"]}, {"cidrs": ["127.0.0.0/8"]},
            {"cidrs": ["10.10.0.1/24"]}, {"ports": [True]}, {"ports": [65536]},
        ):
            with self.subTest(options=options), self.assertRaises(ValueError):
                load_discovery(options)

    def test_scan_uses_only_eligible_addresses_and_keeps_toml_services_separate(self):
        config = load_discovery({"enabled": True, "cidrs": ["10.10.0.0/24", "fd00::/64"], "ports": [22, 443]})
        snapshot = Mock()
        snapshot.settings.discovery = config
        guest = {
            "name": "demo-app", "vmid": 900, "kind": "lxc", "node": "demo-a", "status": "running",
            "networks": [{"ipv4": "10.10.0.7/24", "ipv6": "fd00::7/64"},
                         {"ipv4": "10.10.0.7", "ipv6": "auto"}, {"ipv4": "10.20.0.1"}, {"ipv4": "dhcp"}],
        }
        snapshot.get.return_value = {
            "dashboard": {"show_addresses": False},
            "sources": [
                {"label": "Lab", "error": None, "guests": [
                    guest, {**guest, "status": "stopped", "networks": [{"ipv4": "10.10.0.8"}]},
                ]},
                {"label": "Niedostępne", "error": "timeout", "guests": [
                    {**guest, "networks": [{"ipv4": "10.10.0.9"}]},
                ]},
            ],
            "services": [{"name": "usługa z TOML"}],
        }
        with patch("lab_mon.discovery.probe", side_effect=lambda check: check[1] == 443) as check:
            result = Discovery(snapshot).scan()
        self.assertEqual({(str(address), port) for address, port in (call.args[0] for call in check.call_args_list)},
                         {(address, port) for address in ("10.10.0.7", "fd00::7") for port in (22, 443)})
        self.assertEqual(check.call_count, 4)
        snapshot.get.assert_called_once_with(include_hidden_addresses=True)
        self.assertEqual(result["source_errors"], 1)
        self.assertEqual(result["addresses"], 2)
        self.assertEqual([item["port"] for item in result["services"]], [443, 443])
        self.assertTrue(all(item["address"] is None for item in result["services"]))
        self.assertNotIn("usługa z TOML", json.dumps(result))

    def test_probe_detects_a_listening_tcp_socket(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            target = (ip_address("127.0.0.1"), listener.getsockname()[1])
            self.assertTrue(probe(target))
        self.assertFalse(probe(target))

    def test_demo_route_returns_sample_without_probing(self):
        with tempfile.TemporaryDirectory() as folder, patch("lab_mon.discovery.probe") as probe_mock:
            settings = load_settings(Path(folder) / "config.toml", demo=True)
            app = create_app(Snapshot(settings))
            status = []
            request = {"PATH_INFO": "/api/discovery", "REQUEST_METHOD": "GET"}
            payload = json.loads(b"".join(app(request, lambda code, headers: status.append(code))))
        self.assertEqual(status, ["200 OK"])
        self.assertTrue(payload["demo"])
        self.assertEqual(payload["services"][0]["port"], 8080)
        probe_mock.assert_not_called()
