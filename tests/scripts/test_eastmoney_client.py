"""EastmoneyClient 单元测试 — 全 mock 网络，无真实流量。

import 路径照搬 test_iwencai_client.py 的模式：sys.path.insert _shared 目录。
"""
import sys
from pathlib import Path
from unittest import mock

import pytest
import requests

shared_dir = Path(__file__).parent.parent.parent / "skills" / "_shared"
sys.path.insert(0, str(shared_dir))


@pytest.fixture
def no_key(monkeypatch):
    monkeypatch.delenv("EM_API_KEY", raising=False)
    monkeypatch.delenv("EM_BASE_URL", raising=False)


def test_unconfigured_key_marks_unavailable(no_key):
    import eastmoney_client
    eastmoney_client._client = None  # 重置单例，避免上一个测试的 available 状态泄漏
    from eastmoney_client import EastmoneyClient
    c = EastmoneyClient()
    assert c.available is False


def test_unconfigured_get_client_singleton(no_key):
    import eastmoney_client
    eastmoney_client._client = None
    c = eastmoney_client.get_client()
    assert c.available is False
    # 单例：再次获取是同一对象
    assert eastmoney_client.get_client() is c


@pytest.fixture
def with_key(monkeypatch):
    monkeypatch.setenv("EM_API_KEY", "test_key_123")
    import eastmoney_client
    eastmoney_client._client = None


def _ok_payload(data):
    """构造 200 成功响应 mock。"""
    r = mock.Mock()
    r.status_code = 200
    r.content = b'{"data": "x"}'
    r.json.return_value = data
    return r


def _status_payload(code):
    r = mock.Mock()
    r.status_code = code
    r.content = b'{"err": 1}'
    return r


def test_post_mcp_success(with_key):
    from eastmoney_client import get_client
    c = get_client()
    expected = {"code": 0, "data": {"searchDataResultDTO": {"dataTableDTOList": []}}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(expected)) as mp:
        out = c._post_mcp({"query": "茅台"}, "searchData", "em/search_data")
    assert out == expected
    assert mp.call_count == 1
    # 验证 url 与 header
    args, kwargs = mp.call_args
    assert "/proxy/b/mcp/tool/searchData" in args[0]
    assert kwargs["headers"]["em_api_key"] == "test_key_123"


def test_post_mcp_401_short_circuits(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with mock.patch("eastmoney_client.requests.post", return_value=_status_payload(401)) as mp:
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}
        # 第二次：available 已 False，不应再请求
        assert c._post_mcp({"query": "x"}, "searchData", "em/test2") == {}
    assert mp.call_count == 1


def test_post_mcp_5xx_retried_once(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with mock.patch("eastmoney_client.requests.post", return_value=_status_payload(500)) as mp, \
         mock.patch("eastmoney_client.time.sleep"):
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}
    assert mp.call_count == 2  # 重试 1 次


def test_post_mcp_timeout_retried_then_empty(with_key):
    """ConnectionError/Timeout 重试一次后返回空。"""
    from eastmoney_client import get_client
    c = get_client()
    err = requests.exceptions.Timeout("simulated timeout")
    with mock.patch("eastmoney_client.requests.post", side_effect=err) as mp, \
         mock.patch("eastmoney_client.time.sleep"):
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}
    assert mp.call_count == 2  # 重试 1 次


def test_post_mcp_json_parse_error_returns_empty(with_key):
    """resp.json() 抛异常时走 except Exception 兜底，返回空。"""
    from eastmoney_client import get_client
    c = get_client()
    r = mock.Mock()
    r.status_code = 200
    r.content = b"not json"
    r.json.side_effect = ValueError("invalid json")
    with mock.patch("eastmoney_client.requests.post", return_value=r):
        assert c._post_mcp({"query": "x"}, "searchData", "em/test") == {}


def test_record_call_emitted_on_success_and_failure(with_key, monkeypatch):
    """成功和失败两条路径都调 record_call。"""
    import eastmoney_client
    calls = []
    monkeypatch.setattr(eastmoney_client, "record_call",
                        lambda stage, success, **kw: calls.append((stage, success)))
    c = eastmoney_client.get_client()
    # success path
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload({"code": 0})):
        c._post_mcp({"query": "x"}, "searchData", "em/ok")
    # failure path (401)
    with mock.patch("eastmoney_client.requests.post", return_value=_status_payload(401)):
        c._post_mcp({"query": "x"}, "searchData", "em/fail")
    success_calls = [x for x in calls if x[1] is True]
    failure_calls = [x for x in calls if x[1] is False]
    assert len(success_calls) == 1 and success_calls[0][0] == "em/ok"
    assert len(failure_calls) == 1 and failure_calls[0][0] == "em/fail"


def test_search_news_extracts_text(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": {"llmSearchResponse": "茅台三季度营收同比增长..."}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.search_news("茅台")
    assert out == "茅台三季度营收同比增长..."
    _, kwargs = mp.call_args
    body = kwargs["json"]
    assert body["query"] == "茅台"
    assert "callId" in body["toolContext"]
    assert "userId" in body["toolContext"]["userInfo"]  # 补上官方缺的 userId


def test_search_macro_data_parses_frequency(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {
        "data": {
            "dataTables": [
                {
                    "table": {"headName": ["指标", "2023年"], "EMM0001": ["GDP", "5.2%"]},
                    "nameMap": {"EMM0001": "国内生产总值"},
                    "entityName": "GDP（年）",
                }
            ]
        }
    }
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)):
        out = c.search_macro_data("中国 GDP 增速")
    assert out["tables"][0]["frequency"] == "yearly"
    assert out["tables"][0]["indicator_name"] == "国内生产总值"


def test_select_security_passes_select_type(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": {"allResults": {"result": {"dataList": [["600519", "贵州茅台"]], "columns": [{"field": "code"}, {"field": "name"}]}}, "securityCount": 1}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.select_security("股价大于500元的股票", "A股")
    assert out["count"] == 1
    assert out["rows"][0]["name"] == "贵州茅台"
    _, kwargs = mp.call_args
    assert kwargs["json"]["selectType"] == "A股"


def test_search_data_direct_query(with_key):
    """单实体（≤5）走直接查数，不走 toolPreTaskResultList。"""
    from eastmoney_client import get_client
    c = get_client()
    entity_resp = {"data": {"entityList": [{"entityId": "E1", "secuCode": "600519", "marketChar": "SH", "fullName": "贵州茅台"}]}}
    data_resp = {"code": 0, "data": {"searchDataResultDTO": {"dataTableDTOList": [{"title": "茅台财报", "table": {"headName": ["指标"], "PE": ["30"]}}]}}}
    responses = [_ok_payload(entity_resp), _ok_payload(data_resp)]
    with mock.patch("eastmoney_client.requests.post", side_effect=responses) as mp:
        out = c.search_data("贵州茅台 财务数据")
    assert out["tables"][0]["title"] == "茅台财报"
    assert out["use_entity_tags"] is False
    assert mp.call_count == 2  # 实体识别 + 查数


def test_search_data_multi_entity_uses_tool_pre_task(with_key):
    """>5 实体走多实体：query 改写为「选定实体的{indicators}」，带 toolPreTaskResultList。"""
    from eastmoney_client import get_client
    c = get_client()
    entities = [{"entityId": f"E{i}", "secuCode": f"60000{i}", "marketChar": "SH"} for i in range(6)]
    entity_resp = {"data": {"entityList": entities}}
    data_resp = {"code": 0, "data": {"searchDataResultDTO": {"dataTableDTOList": []}}}
    responses = [_ok_payload(entity_resp), _ok_payload(data_resp)]
    with mock.patch("eastmoney_client.requests.post", side_effect=responses) as mp:
        out = c.search_data("白酒板块 营收 净利", indicators="营收 净利")
    assert out["use_entity_tags"] is True
    assert out["search_query"] == "选定实体的营收 净利"
    _, kwargs = mp.call_args_list[1]  # 第二次请求（查数）
    tctx = kwargs["json"]["toolContext"]
    assert "toolPreTaskResultList" in tctx


def test_recognize_entities_extracts_tags(with_key):
    from eastmoney_client import get_client
    c = get_client()
    entity_resp = {"data": {"entityList": [{"entityId": "E1", "secuCode": "600519", "marketChar": "SH", "fullName": "贵州茅台"}]}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(entity_resp)):
        tags = c.recognize_entities("贵州茅台")
    assert len(tags) == 1
    assert tags[0]["entityId"] == "E1"
    assert tags[0]["secuCode"] == "600519"


def test_diagnose_stock_extracts_display_data(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": {"displayData": "## 贵州茅台诊断报告\n基本面稳健..."}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.diagnose_stock("贵州茅台怎么样？")
    assert "贵州茅台诊断报告" in out
    args, kwargs = mp.call_args
    assert kwargs["json"] == {"question": "贵州茅台怎么样？"}
    assert "/stock-analysis" in args[0]


def test_diagnose_fund_and_hotspot_with_key(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload({"data": {"displayData": "x"}})):
        assert c.diagnose_fund("华夏成长怎么样") == "x"
        assert c.discover_hotspot("今日热点") == "x"


def test_comparable_company_returns_list_structure(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": [
        {"type": "header", "company": "贵州茅台"},
        {"type": "section_finance", "rows": [["营收", "100亿"]]},
    ]}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.comparable_company_analysis("贵州茅台 同业对比")
    assert out["success"] is True
    assert len(out["data"]) == 2
    assert "/comparable-company-analysis" in mp.call_args.args[0]


def test_ask_omits_deepthink_when_false(with_key):
    """deep_think=False 时不下发 deepThink key（对齐官方'省略即关闭'）。"""
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": {"displayData": "茅台当前估值...", "refIndexList": [{"refId": 1, "type": "资讯"}]}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.ask("茅台当前估值")
    assert "deepThink" not in mp.call_args.kwargs["json"]
    assert "估值" in out["answer"]
    assert out["references"][0]["refId"] == 1


def test_ask_includes_deepthink_when_true(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload({"code": 200, "data": {"displayData": "x"}})) as mp:
        c.ask("茅台", deep_think=True)
    assert mp.call_args.kwargs["json"]["deepThink"] is True


def test_search_kb_returns_chunks(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": {"chunks": [{"title": "宁德时代研报", "text": "营收增长...", "fileName": "研报.md"}]}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)):
        out = c.search_kb("宁德时代")
    assert out["content"]  # 有内容
    assert out["valid"] is True


def test_search_kb_filters_status_message(with_key):
    """'您暂无知识库权限'这类纯状态文案应标 valid=False。"""
    from eastmoney_client import get_client
    c = get_client()
    payload = {"data": "您暂无知识库权限"}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)):
        out = c.search_kb("x")
    assert out["valid"] is False


def test_generate_report_returns_title_content_and_attachments(with_key):
    from eastmoney_client import get_client
    c = get_client()
    payload = {"code": 200, "data": {"title": "半导体行业研究报告", "content": "## 行业概述\n...", "shareUrl": "http://x", "pdfBase64": "JVBERi0=", "wordBase64": "UEsDBA=="}}
    with mock.patch("eastmoney_client.requests.post", return_value=_ok_payload(payload)) as mp:
        out = c.generate_report("industry", "半导体行业")
    assert out["title"] == "半导体行业研究报告"
    assert out["shareUrl"] == "http://x"
    assert out["attachments"]["pdf"] == "JVBERi0="
    assert out["attachments"]["word"] == "UEsDBA=="
    # url 是 requests.post 第一个位置参数，path 含 write/industry/research
    assert "write/industry/research" in mp.call_args.args[0]


def test_generate_report_unknown_kind_raises(with_key):
    from eastmoney_client import get_client
    c = get_client()
    with pytest.raises(ValueError):
        c.generate_report("nonexistent", "x")
