import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from lab_mon.__main__ import create_app
from lab_mon.config import Source, load_settings
from lab_mon.proxmox import APIError, Proxmox, Snapshot


class LabMonTests(unittest.TestCase):
    def setUp(self):
        self.source = Source("demo", "Próba", "https://pve.example.invalid:8006",
                             "monitor@pve!test", "fake-token", None)

    def test_get_uses_readonly_request_with_token(self):
        client = Proxmox(self.source, 5)
        with patch.object(client.opener, "open", return_value=io.BytesIO(b'{"data":[]}')) as opened:
            self.assertEqual(client.get("/cluster/resources", list), [])
        request = opened.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "PVEAPIToken=monitor@pve!test=fake-token")
        self.assertEqual(request.full_url, "https://pve.example.invalid:8006/api2/json/cluster/resources")

    def test_error_omits_url_and_token(self):
        client = Proxmox(self.source, 5)
        error = HTTPError(self.source.url, 403, self.source.token_secret, {}, io.BytesIO())
        with patch.object(client.opener, "open", side_effect=error):
            with self.assertRaises(APIError) as caught:
                client.get("/cluster/resources", list)
        self.assertEqual(str(caught.exception), "Proxmox zwrócił HTTP 403.")

    def test_cluster_inventory_lxc_qemu_and_networks(self):
        client = Proxmox(self.source, 5)
        responses = {
            "/cluster/resources": [
                {"type": "node", "node": "pve-a", "status": "online"},
                {"type": "lxc", "node": "pve-a", "vmid": 101, "name": "container"},
                {"type": "qemu", "node": "pve-b", "vmid": 102, "name": "vm"},
                {"type": "storage", "node": "pve-a"},
            ],
            "/cluster/status": [{"type": "node", "name": "pve-a", "ip": "192.0.2.10"}],
            "/nodes/pve-a/lxc/101/config": {
                "net0": "name=eth0,bridge=vmbr0,ip=192.0.2.101/24,gw=192.0.2.1",
                "net1": "name=eth1,bridge=vmbr1,ip6=auto",
                "unused0": "not-displayed",
            },
            "/nodes/pve-b/qemu/102/config": {
                "net0": "virtio=00:00:00:00:00:00,bridge=vmbr1,tag=42",
                "ipconfig0": "ip=dhcp,ip6=2001:db8::10/64",
            },
        }
        with patch.object(client, "get", side_effect=lambda path, _: responses[path]):
            nodes, guests = client.inventory(True)
        self.assertEqual(nodes[0]["ip"], "192.0.2.10")
        self.assertEqual(len(guests), 2)
        self.assertEqual(guests[0]["networks"][0]["gateway"], "192.0.2.1")
        self.assertEqual(guests[0]["networks"][1]["ipv6"], "auto")
        self.assertEqual(guests[1]["node"], "pve-b")
        self.assertEqual(guests[1]["networks"][0]["ipv4"], "dhcp")
        self.assertEqual(guests[1]["networks"][0]["vlan"], "42")

    def test_redaction_and_stale_snapshot(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"PVE_TOKEN_ID": "monitor@pve!test", "PVE_TOKEN_SECRET": "fake-token"}):
            path = Path(temp) / "config.toml"
            path.write_text(Path("config.example.toml").read_text().replace("show_addresses = true", "show_addresses = false"))
            snapshot = Snapshot(load_settings(path))
            client = snapshot.clients["lab"]
            with patch.object(client, "inventory", side_effect=[
                ([{"name": "pve", "ip": "192.0.2.10"}], [{"networks": [{"ipv4": "192.0.2.50"}]}]),
                APIError("Niedostępne"),
            ]) as inventory:
                first = snapshot.get()
                self.assertEqual(snapshot.get(), first)
                self.assertEqual(inventory.call_count, 1)
                snapshot.last_poll = float("-inf")
                stale = snapshot.get()
            self.assertEqual(stale["sources"][0]["error"], "Niedostępne")
            self.assertEqual(stale["sources"][0]["collected_at"], first["sources"][0]["collected_at"])
            self.assertIsNone(stale["sources"][0]["nodes"][0]["ip"])
            self.assertIsNone(stale["sources"][0]["guests"][0]["networks"][0]["ipv4"])
            self.assertEqual(stale["services"][0]["endpoint"], "")
            self.assertEqual(stale["source_configuration"][0]["url"], "")
            self.assertNotIn("fake-token", json.dumps(stale))

    def test_saved_sources_and_services_are_visible_when_proxmox_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(
            "os.environ", {"PVE_TOKEN_ID": "monitor@pve!test", "PVE_TOKEN_SECRET": "fake-token"}
        ):
            path = Path(temp) / "config.toml"
            path.write_text(Path("config.example.toml").read_text().replace(
                '# ca_file = "proxmox-ca.pem"', 'ca_file = "certs/lab.pem"'
            ))
            snapshot = Snapshot(load_settings(path))
            result = snapshot.get()
        self.assertIsNotNone(result["sources"][0]["error"])
        self.assertEqual(result["source_configuration"][0], {
            "id": "lab", "label": "Laboratorium", "url": "https://proxmox.example.invalid:8006",
            "ca_file": "certs/lab.pem", "token_id_env": "PVE_TOKEN_ID", "token_secret_env": "PVE_TOKEN_SECRET",
        })
        self.assertEqual(result["services"][0]["vmid"], 900)
        payload = json.dumps(result)
        self.assertNotIn("fake-token", payload)
        self.assertNotIn("monitor@pve!test", payload)

    def test_wsgi_demo_and_method_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(Snapshot(load_settings(Path(temp) / "missing.toml", demo=True)))
            calls = []
            respond = lambda status, headers: calls.append((status, dict(headers)))
            request = {"PATH_INFO": "/api/snapshot", "REQUEST_METHOD": "GET"}
            payload = json.loads(b"".join(app(request, respond)))
            self.assertTrue(payload["dashboard"]["demo"])
            self.assertEqual(len(payload["sources"][0]["nodes"]), 2)
            self.assertEqual(calls[-1][1]["Cache-Control"], "no-store")
            app({**request, "REQUEST_METHOD": "POST"}, respond)
            self.assertEqual(calls[-1][0], "405 Method Not Allowed")
            app({"PATH_INFO": "/bootstrap.min.css", "REQUEST_METHOD": "GET"}, respond)
            self.assertEqual(calls[-1][0], "200 OK")


if __name__ == "__main__":
    unittest.main()
