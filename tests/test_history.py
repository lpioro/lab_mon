import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from lab_mon.__main__ import create_app
from lab_mon.config import HistorySettings, Source, load_settings
from lab_mon.history import History
from lab_mon.proxmox import APIError, Snapshot


class HistoryTests(unittest.TestCase):
    def test_samples_persist_and_api_failure_leaves_a_gap(self):
        with tempfile.TemporaryDirectory() as folder:
            config = HistorySettings(path=Path(folder) / "history.sqlite3")
            source = Source("lab", "Laboratorium", "https://demo.example.invalid",
                            "demo@pve!monitor", "demo-only", None)
            client = Mock()
            node = {"type": "node", "node": "pve-a", "status": "online", "cpu": 0.2,
                    "mem": 2, "maxmem": 8, "uptime": 1000}
            client.node_metrics.side_effect = [
                [node], APIError("niedostępny"), [{**node, "status": "offline"}],
            ]
            history = History(config, [source], {"lab": client})
            for clock in (100000, 100060, 100120):
                with patch("lab_mon.history.time.time", return_value=clock):
                    history.sample()

            reopened = History(config, [source], {})
            with patch("lab_mon.history.time.time", return_value=100130):
                result = reopened.query("1h", "lab", "pve-a")
            self.assertEqual(len(result["points"]), 2)
            self.assertEqual(result["recent"][0]["status"], "offline")
            self.assertIsNone(result["recent"][0]["cpu"])
            self.assertEqual(result["recent"][1]["cpu"], 20)
            self.assertEqual(result["recent"][1]["ram"], 25)
            self.assertEqual(result["recent"][1]["uptime"], 1000)
            self.assertEqual(result["points"][1]["bucket"] - result["points"][0]["bucket"], 2)
            self.assertNotIn("demo-only", json.dumps(result))

    def test_retention_applies_without_successful_reads(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Source("lab", "Lab", "https://demo.example.invalid", "demo@pve!monitor", "demo-only", None)
            client = Mock()
            client.node_metrics.side_effect = [[{"type": "node", "node": "pve-a"}], APIError("offline")]
            history = History(HistorySettings(retention_days=1, path=Path(folder) / "history.sqlite3"),
                              [source], {"lab": client})
            with patch("lab_mon.history.time.time", return_value=100000):
                history.sample()
            with patch("lab_mon.history.time.time", return_value=186401):
                history.sample()
                self.assertEqual(history.query("7d", "", "")["hosts"], [])

    def test_demo_route_and_invalid_range(self):
        with tempfile.TemporaryDirectory() as folder:
            settings = load_settings(Path(folder) / "config.toml", demo=True)
            app = create_app(Snapshot(settings))
            calls = []
            respond = lambda status, headers: calls.append(status)
            env = {"PATH_INFO": "/api/history", "REQUEST_METHOD": "GET",
                   "QUERY_STRING": "range=24h&source=demo&node=demo-b"}
            result = json.loads(b"".join(app(env, respond)))
            self.assertEqual(calls[-1], "200 OK")
            self.assertEqual(result["selected"]["node"], "demo-b")
            self.assertEqual(result["bucket_seconds"], 300)
            self.assertGreater(len(result["points"]), 100)
            app({**env, "QUERY_STRING": "range=unknown"}, respond)
            self.assertEqual(calls[-1], "400 Bad Request")
