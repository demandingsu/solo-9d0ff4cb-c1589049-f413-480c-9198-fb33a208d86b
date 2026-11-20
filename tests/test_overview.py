"""总览接口测试：单次已提交快照一致性、读取中交印不阻塞、格式与旧接口一致。

运行：
    PYTHONPATH=. pytest -q
"""
from __future__ import annotations

import io
import os
import tempfile

import pytest

# 与 test_api.py 同一套临时库约定：先设置环境变量再导入 app
_tmp = tempfile.TemporaryDirectory()
os.environ.setdefault("MATRIX_DB_PATH", os.path.join(_tmp.name, "test_overview.db"))

from fastapi.testclient import TestClient  # noqa: E402

from app import service  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    service.ensure_db()
    service.reset_all()
    with TestClient(app) as c:
        yield c


def _csv(text: str) -> bytes:
    return text.encode("utf-8-sig")


def _upload_lib(client, rows: list[tuple[str, str, str, str]]):
    buf = io.StringIO()
    buf.write("字库,版次,字模号,字\n")
    for r in rows:
        buf.write(",".join(r) + "\n")
    return client.post(
        "/api/libraries",
        files={"file": ("libraries.csv", _csv(buf.getvalue()), "text/csv")},
    )


def _upload_vol(client, name: str, chars: str):
    body = "字\n" + "\n".join(chars) + "\n"
    return client.post(
        f"/api/volumes/{name}/chars",
        files={"file": (f"{name}.csv", _csv(body), "text/csv")},
    )


# ---------- 总览格式：与 /api/state、/api/orders 完全一致 ----------


def test_overview_matches_state_and_orders_formats(client):
    _upload_lib(client, [
        ("宋韵楼", "初刻", "SR-1", "天"),
        ("宋韵楼", "初刻", "SR-2", "地"),
    ])
    _upload_vol(client, "册甲", "天地")
    client.post("/api/volumes/册甲/submit")

    r = client.get("/api/overview")
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d.keys()) == {"state", "orders"}
    # 两个部分与原接口响应格式（及内容）完全一致
    assert d["state"] == client.get("/api/state").json()
    assert d["orders"] == client.get("/api/orders").json()


def test_overview_empty_initially(client):
    d = client.get("/api/overview").json()
    assert d["state"] == {"libraries": [], "volumes": [], "shared_pool": []}
    assert d["orders"] == []


# ---------- 核心：同一次已提交快照；读取中他人仍可交印 ----------


def test_overview_snapshot_consistent_while_submit_in_progress(client):
    _upload_lib(client, [
        ("宋韵楼", "初刻", "SR-1", "天"),
        ("宋韵楼", "初刻", "SR-2", "地"),
    ])
    _upload_vol(client, "册甲", "天")
    _upload_vol(client, "册乙", "地")
    o1 = client.post("/api/volumes/册甲/submit").json()

    # 模拟一次“尚未读完”的总览：只读事务已开启，先读了状态部分
    conn = service.connect()
    conn.execute("BEGIN")
    try:
        state_part = service._state_snapshot(conn)

        # 读取尚未完成时，另一人提交交印 —— 不应被总览读取阻塞
        r = client.post("/api/volumes/册乙/submit")
        assert r.status_code == 200, r.text
        new_order = r.json()

        # 同一快照内再读单列表：状态与列表来自同一次已提交的工位状态
        orders_part = service._orders_snapshot(conn)
        assert [o["order_no"] for o in orders_part] == [o1["order_no"]]
        assert {x["glyph_char"] for x in state_part["shared_pool"]} == {"天"}
        yi = next(v for v in state_part["volumes"] if v["volume"] == "册乙")
        assert yi["active_matrices"] == []
    finally:
        conn.rollback()
        conn.close()

    # 下一次总览：新单与册乙的新字模一起出现（一起更新）
    ov = client.get("/api/overview").json()
    assert [o["order_no"] for o in ov["orders"]] == [
        o1["order_no"],
        new_order["order_no"],
    ]
    assert {x["glyph_char"] for x in ov["state"]["shared_pool"]} == {"天", "地"}
    yi = next(v for v in ov["state"]["volumes"] if v["volume"] == "册乙")
    assert {x["glyph_char"] for x in yi["active_matrices"]} == {"地"}


def test_concurrent_overview_reads_during_submits(client):
    """交印进行中并发请求总览：每次都成功，且状态与单列表互相一致。"""
    import threading

    _upload_lib(client, [
        ("宋韵楼", "初刻", "SR-1", "天"),
        ("宋韵楼", "初刻", "SR-2", "地"),
        ("宋韵楼", "初刻", "SR-3", "人"),
    ])
    for name, chars in (("册甲", "天"), ("册乙", "地"), ("册丙", "人")):
        _upload_vol(client, name, chars)

    errors: list[Exception] = []
    barrier = threading.Barrier(6)

    def submitter(vol: str):
        try:
            barrier.wait()
            with TestClient(app) as local:
                resp = local.post(f"/api/volumes/{vol}/submit")
                assert resp.status_code == 200, resp.text
        except Exception as exc:  # pragma: no cover - 测试失败路径
            errors.append(exc)

    def reader():
        try:
            barrier.wait()
            with TestClient(app) as local:
                resp = local.get("/api/overview")
                assert resp.status_code == 200, resp.text
                d = resp.json()
            # 单次快照自洽：已交印字模并集的大小与单列表反映的进度不矛盾
            pool_chars = {x["glyph_char"] for x in d["state"]["shared_pool"]}
            assert len(pool_chars) == len(d["orders"])
        except Exception as exc:  # pragma: no cover - 测试失败路径
            errors.append(exc)

    threads = [
        *(threading.Thread(target=submitter, args=(v,)) for v in ("册甲", "册乙", "册丙")),
        *(threading.Thread(target=reader) for _ in range(3)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors

    final = client.get("/api/overview").json()
    assert len(final["orders"]) == 3
    assert {x["glyph_char"] for x in final["state"]["shared_pool"]} == {"天", "地", "人"}
