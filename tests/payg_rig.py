"""Shared harness for the pay-as-you-go tests: a real engine on a real socket, a private ledger file, and
signed keys of any scope. Not a test module."""
import json
import urllib.error
import urllib.request

import pytest

from gridforge.api import keys as K
from gridforge.api import server as S
from gridforge.api.ledger import Ledger
from gridforge.api.costs import CostMeter
from gridforge.api.metering import UNIT_COST, Meter
from gridforge.commercial import PAYG
import threading

INTAKE = {"grid": {"contracted_MW": 12, "firm_capacity_MVA": 12}}
ADMIN = "admin-key-for-payg-tests"


class Rig:
    def __init__(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GRIDFORGE_KEY_SECRET", "payg-http-secret")
        monkeypatch.setenv("GRIDFORGE_ADMIN_KEY", ADMIN)
        monkeypatch.delenv("GRIDFORGE_API_KEYS", raising=False)
        monkeypatch.delenv("GRIDFORGE_REVOKED_KEYS", raising=False)
        monkeypatch.delenv("GRIDFORGE_REVOKED_FILE", raising=False)
        monkeypatch.setattr(S.Handler.limiter, "per_minute", 0)
        self.monkeypatch = monkeypatch
        self.ledger_path = tmp_path / "ledger.jsonl"
        self.cost_path = tmp_path / "costs.json"
        self.meter = None
        self.httpd = None
        self.restart()

    def restart(self):
        """A new engine process over the same files: a fresh meter and an empty response cache."""
        if self.httpd:
            self.httpd.shutdown()
        self.meter = Meter(None, Ledger(self.ledger_path), CostMeter(self.cost_path))
        self.monkeypatch.setattr(S, "METER", self.meter)
        self.monkeypatch.setattr(S, "IDEMPOTENCY", S._IdempotencyCache())
        self.httpd = S.make_server("127.0.0.1", 0)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()

    def key(self, scope="payg", quota=50, account="acme"):
        return K.issue(account, quota=quota, scope=scope)

    def req(self, method, path, body=None, key=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        if key:
            r.add_header("X-API-Key", key)
        for k, v in (headers or {}).items():
            r.add_header(k, v)
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return resp.status, json.loads(resp.read() or b"{}"), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}"), dict(e.headers)

    def post(self, path, body, **kw):
        return self.req("POST", path, body, **kw)

    def get(self, path, **kw):
        return self.req("GET", path, **kw)

    def events(self):
        if not self.ledger_path.exists():
            return []
        return [json.loads(x) for x in self.ledger_path.read_text().splitlines()]


@pytest.fixture
def rig(tmp_path, monkeypatch):
    r = Rig(tmp_path, monkeypatch)
    yield r
    r.close()


