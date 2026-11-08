from contextlib import closing
from math import isfinite, sin
from threading import Thread
import logging
import sqlite3
import time

from .proxmox import APIError


RANGES = {
    "1h": (3600, 60),
    "24h": (86400, 300),
    "7d": (604800, 1800),
    "30d": (2592000, 7200),
}
LOG = logging.getLogger(__name__)


def number(value):
    return value if type(value) in (int, float) and isfinite(value) and value >= 0 else None


def percent(value, total):
    if value is None or not total:
        return None
    return min(100, round(value / total * 100, 2))


class History:
    def __init__(self, settings, sources, clients):
        self.settings = settings
        self.labels = {source.id: source.label for source in sources}
        self.clients = clients
        settings.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(self.connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS samples (
                    source TEXT NOT NULL,
                    node TEXT NOT NULL,
                    ts INTEGER NOT NULL,
                    cpu REAL,
                    ram REAL,
                    uptime INTEGER,
                    status TEXT NOT NULL,
                    PRIMARY KEY (source, node, ts)
                ) WITHOUT ROWID;
                CREATE INDEX IF NOT EXISTS samples_by_time ON samples(ts);
            """)

    def connect(self):
        db = sqlite3.connect(self.settings.path)
        db.row_factory = sqlite3.Row
        return db

    def start(self):
        Thread(target=self.run, name="proxmox-history", daemon=True).start()

    def run(self):
        while True:
            started = time.monotonic()
            try:
                self.sample()
            except (OSError, sqlite3.Error):
                LOG.warning("Nie udało się zapisać próbek historii Lab Mon.")
            time.sleep(max(1, self.settings.interval_seconds - (time.monotonic() - started)))

    def sample(self):
        rows = []
        for source, client in self.clients.items():
            if client is None:
                continue
            try:
                nodes = client.node_metrics()
            except APIError:
                continue
            now = int(time.time())
            for node in nodes:
                if not isinstance(node, dict) or not isinstance(node.get("node"), str) or node.get("type") != "node":
                    continue
                state = node.get("status")
                state = state if state in ("online", "offline") else "unknown"
                cpu = ram = uptime = None
                if state == "online":
                    cpu = percent(number(node.get("cpu")), 1)
                    ram = percent(number(node.get("mem")), number(node.get("maxmem")))
                    uptime = number(node.get("uptime"))
                rows.append((source, node["node"], now, cpu, ram, uptime, state))
        cutoff = int(time.time()) - self.settings.retention_days * 86400
        with closing(self.connect()) as db, db:
            db.executemany("INSERT OR IGNORE INTO samples VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))

    def query(self, span, source, node):
        duration, bucket = RANGES[span]
        bucket = max(bucket, self.settings.interval_seconds)
        end = int(time.time())
        start = end - duration
        with closing(self.connect()) as db:
            hosts = [
                {**row, "label": self.labels[row["source"]]}
                for row in db.execute("SELECT DISTINCT source, node FROM samples ORDER BY source, node")
                if row["source"] in self.labels
            ]
            host = choose_host(hosts, source, node)
            points, recent = [], []
            if host:
                host_args = (host["source"], host["node"], start, end)
                points = [dict(row) for row in db.execute("""
                    SELECT CAST((ts - ?) / ? AS INTEGER) AS bucket,
                           CAST(AVG(ts) AS INTEGER) AS ts, AVG(cpu) AS cpu, AVG(ram) AS ram
                    FROM samples WHERE source = ? AND node = ? AND ts BETWEEN ? AND ?
                    GROUP BY bucket ORDER BY bucket
                """, (start, bucket, *host_args))]
                recent = [dict(row) for row in db.execute("""
                    SELECT ts, cpu, ram, uptime, status FROM samples
                    WHERE source = ? AND node = ? AND ts BETWEEN ? AND ?
                    ORDER BY ts DESC LIMIT 10
                """, host_args)]
        return payload(hosts, host, start, end, bucket, points, recent)


def choose_host(hosts, source, node):
    return next((item for item in hosts if (item["source"], item["node"]) == (source, node)),
                hosts[0] if hosts else None)


def payload(hosts, host, start, end, bucket, points, recent):
    return {
        "hosts": hosts, "selected": host, "start": start, "end": end,
        "bucket_seconds": bucket, "points": points, "recent": recent,
    }


def demo_history(span, source, node):
    duration, bucket = RANGES[span]
    end = int(time.time())
    start = end - duration
    hosts = [{"source": "demo", "label": "Źródło demonstracyjne", "node": name}
             for name in ("demo-a", "demo-b")]
    host = choose_host(hosts, source, node)
    phase = 3 if host["node"] == "demo-b" else 0
    points, recent = [], []
    for index, ts in enumerate(range(start, end + 1, bucket)):
        if index % 31 in (14, 15, 16):
            continue
        cpu = round(23 + 11 * sin(index / 4 + phase) + 7 * sin(index * 1.6), 2)
        ram = round(57 + 8 * sin(index / 11 + phase), 2)
        points.append({"bucket": index, "ts": ts, "cpu": cpu, "ram": ram})
        recent.append({"ts": ts, "cpu": cpu, "ram": ram, "status": "online", "uptime": 421500 + ts - start})
    return payload(hosts, host, start, end, bucket, points, recent[-10:][::-1])
