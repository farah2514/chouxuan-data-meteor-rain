import csv
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import xlsxwriter


ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8877"))
HOST = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
FEISHU_APP_ID = (os.environ.get("FEISHU_APP_ID") or os.environ.get("LARK_APP_ID") or "").strip()
FEISHU_APP_SECRET = (os.environ.get("FEISHU_APP_SECRET") or os.environ.get("LARK_APP_SECRET") or "").strip()
FEISHU_FOLDER_TOKEN = (os.environ.get("FEISHU_FOLDER_TOKEN") or "").strip()
FEISHU_API_BASE = (os.environ.get("FEISHU_API_BASE") or "https://open.feishu.cn").rstrip("/")
TOKEN_CACHE = {
    "tenant_access_token": "",
    "expire_at": 0,
}


def excel_col_name(index):
    result = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def compact_ranges(numbers):
    if not numbers:
        return []
    sorted_numbers = sorted(set(numbers))
    ranges = []
    start = prev = sorted_numbers[0]
    for number in sorted_numbers[1:]:
        if number == prev + 1:
            prev = number
            continue
        ranges.append((start, prev))
        start = prev = number
    ranges.append((start, prev))
    return ranges


def find_first_key(payload, target_keys):
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in target_keys and value:
                return value
            found = find_first_key(value, target_keys)
            if found:
                return found
    if isinstance(payload, list):
        for item in payload:
            found = find_first_key(item, target_keys)
            if found:
                return found
    return None


def strip_internal_fields(row, headers):
    return {header: row.get(header, "") for header in headers}


def build_export_dataset(headers, active_rows, sampled_row_ids, mode, format_name):
    clean_headers = [header for header in headers if header and not str(header).startswith("__")]
    sampled_set = set(sampled_row_ids or [])
    ordered_rows = []
    highlighted_positions = []

    for row in active_rows or []:
        row_id = row.get("__rowId")
        is_sampled = row_id in sampled_set
        if mode == "sampled_only" and not is_sampled:
            continue
        clean_row = strip_internal_fields(row, clean_headers)
        if mode == "full_with_highlight" and format_name in {"csv", "lark"}:
            clean_row = {"抽样标记": "已抽中" if is_sampled else "", **clean_row}
        ordered_rows.append(clean_row)
        if mode == "full_with_highlight" and is_sampled:
            highlighted_positions.append(len(ordered_rows) - 1)

    export_headers = list(ordered_rows[0].keys()) if ordered_rows else (
        ["抽样标记", *clean_headers] if mode == "full_with_highlight" and format_name in {"csv", "lark"} else clean_headers
    )
    matrix = [[row.get(header, "") for header in export_headers] for row in ordered_rows]
    return {
        "headers": export_headers,
        "rows": ordered_rows,
        "matrix": matrix,
        "highlighted_positions": highlighted_positions,
    }


def build_csv_bytes(headers, rows):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(headers)
    for row in rows:
        writer.writerow([row.get(header, "") for header in headers])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def build_xlsx_bytes(headers, rows, highlighted_positions):
    output = io.BytesIO()
    workbook = xlsxwriter.Workbook(output, {"in_memory": True})
    worksheet = workbook.add_worksheet("导出结果")
    header_fmt = workbook.add_format({
        "bold": True,
        "bg_color": "#F3F4F6",
        "border": 1,
    })
    normal_fmt = workbook.add_format({"border": 1})
    highlight_fmt = workbook.add_format({
        "bg_color": "#DBEAFE",
        "font_color": "#1E3A8A",
        "border": 1,
    })

    for col_idx, header in enumerate(headers):
        worksheet.write(0, col_idx, header, header_fmt)
    for row_idx, row in enumerate(rows, start=1):
        fmt = highlight_fmt if (row_idx - 1) in highlighted_positions else normal_fmt
        for col_idx, header in enumerate(headers):
            worksheet.write(row_idx, col_idx, row.get(header, ""), fmt)
    worksheet.freeze_panes(1, 0)
    worksheet.autofilter(0, 0, max(len(rows), 1), max(len(headers) - 1, 0))
    workbook.close()
    output.seek(0)
    return output.read()


def has_feishu_api_config():
    return bool(FEISHU_APP_ID and FEISHU_APP_SECRET)


def parse_spreadsheet_token(url):
    parsed = urlparse((url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError("请填写完整的飞书表格链接。")
    parts = [part for part in parsed.path.split("/") if part]
    for idx, part in enumerate(parts[:-1]):
        if part in {"sheets", "sheet"}:
            return parts[idx + 1]
    if parts:
        fallback = parts[-1]
        if re.fullmatch(r"[A-Za-z0-9]{10,}", fallback):
            return fallback
    raise RuntimeError("没有从链接里识别出飞书表格 token，请确认这是飞书电子表格链接。")


def parse_feishu_error(payload, fallback):
    code = payload.get("code")
    msg = str(payload.get("msg") or fallback or "飞书接口调用失败。").strip()
    if code == 1310213:
        return (
            "当前飞书应用没有这个表格的访问权限。"
            "请先在飞书表格右上角把应用添加为文档应用或协作者，再重试。"
        )
    if code == 99991663:
        return "飞书应用凭证无效，请检查 FEISHU_APP_ID / FEISHU_APP_SECRET 是否填写正确。"
    if code == 99991661:
        return "飞书应用访问凭证已失效，请稍后重试；如果持续失败，请检查应用配置。"
    if "permission" in msg.lower():
        return "飞书接口返回权限不足，请确认应用已开通表格权限，并已被加入目标表格。"
    return f"{msg}（错误码：{code}）" if code not in (None, 0) else msg


def http_json_request(method, url, payload=None, headers=None, timeout=30):
    request_headers = dict(headers or {})
    request_headers.setdefault("Accept", "application/json")
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json; charset=utf-8")
    request = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            status = getattr(response, "status", 200)
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        status = exc.code
    except URLError as exc:
        raise RuntimeError(f"连接飞书接口失败：{exc.reason}") from exc

    if not raw:
        return status, {}
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("飞书接口返回了无法解析的内容。") from exc


def get_tenant_access_token():
    now = time.time()
    if TOKEN_CACHE["tenant_access_token"] and now < TOKEN_CACHE["expire_at"] - 300:
        return TOKEN_CACHE["tenant_access_token"]

    if not has_feishu_api_config():
        raise RuntimeError(
            "当前服务还没有配置飞书应用。请先在部署环境里填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET。"
        )

    status, payload = http_json_request(
        "POST",
        f"{FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal",
        {
            "app_id": FEISHU_APP_ID,
            "app_secret": FEISHU_APP_SECRET,
        },
    )
    if status >= 400 or payload.get("code") != 0:
        raise RuntimeError(parse_feishu_error(payload, "获取飞书 tenant_access_token 失败。"))

    token = payload.get("tenant_access_token") or ""
    expire = int(payload.get("expire") or 7200)
    TOKEN_CACHE["tenant_access_token"] = token
    TOKEN_CACHE["expire_at"] = now + expire
    return token


def feishu_api_request(method, path, payload=None, timeout=30):
    token = get_tenant_access_token()
    status, body = http_json_request(
        method,
        f"{FEISHU_API_BASE}{path}",
        payload=payload,
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout,
    )
    if status >= 400 or body.get("code") != 0:
        raise RuntimeError(parse_feishu_error(body, "飞书接口调用失败。"))
    return body.get("data") or {}


def fetch_feishu_sheets(spreadsheet_token):
    data = feishu_api_request(
        "GET",
        f"/open-apis/sheets/v3/spreadsheets/{quote(spreadsheet_token)}/sheets/query",
    )
    sheets = []
    for item in data.get("sheets", []):
        grid = item.get("grid_properties") or {}
        sheets.append({
            "sheet_id": item.get("sheet_id") or "",
            "sheet_name": item.get("title") or item.get("sheet_name") or "",
            "index": item.get("index", 0),
            "hidden": bool(item.get("hidden")),
            "row_count": grid.get("row_count", 0),
            "column_count": grid.get("column_count", 0),
        })
    return sheets


def feishu_range_text(sheet_id, range_text=""):
    clean_range = (range_text or "").strip()
    return f"{sheet_id}!{clean_range}" if clean_range else sheet_id


def matrix_to_object_rows(values):
    if not values:
        return []
    header = [str(cell or "").strip() for cell in values[0]]
    normalized_rows = []
    for row in values[1:]:
        current = list(row or [])
        if len(current) < len(header):
            current.extend([""] * (len(header) - len(current)))
        if len(current) > len(header):
            current = current[: len(header)]
        normalized_row = {
            header[idx] or f"column_{idx + 1}": str(current[idx] if idx < len(current) else "").strip()
            for idx in range(len(header))
        }
        if not any(str(value or "").strip() for value in normalized_row.values()):
            continue
        normalized_rows.append(normalized_row)
    return normalized_rows


def load_sheet_rows_via_feishu(spreadsheet_token, sheet_id, range_text=""):
    full_range = feishu_range_text(sheet_id, range_text)
    data = feishu_api_request(
        "GET",
        f"/open-apis/sheets/v2/spreadsheets/{quote(spreadsheet_token)}/values/{quote(full_range, safe='')}",
    )
    value_range = data.get("valueRange") or data.get("data") or {}
    values = value_range.get("values") or []
    return {
        "rows": matrix_to_object_rows(values),
        "actual_range": value_range.get("range") or full_range,
    }


def write_sheet_values_via_feishu(spreadsheet_token, range_text, values):
    feishu_api_request(
        "PUT",
        f"/open-apis/sheets/v2/spreadsheets/{quote(spreadsheet_token)}/values",
        payload={
            "valueRange": {
                "range": range_text,
                "values": values,
            }
        },
    )


def create_lark_workbook_via_feishu(title, headers, matrix, highlighted_positions):
    payload = {"title": title}
    if FEISHU_FOLDER_TOKEN:
        payload["folder_token"] = FEISHU_FOLDER_TOKEN
    created = feishu_api_request(
        "POST",
        "/open-apis/sheets/v3/spreadsheets",
        payload=payload,
    )
    spreadsheet = created.get("spreadsheet") or {}
    spreadsheet_token = spreadsheet.get("spreadsheet_token") or ""
    spreadsheet_url = spreadsheet.get("url") or ""
    sheets = fetch_feishu_sheets(spreadsheet_token)
    if not sheets:
        raise RuntimeError("飞书表格已创建，但没有拿到默认工作表信息。")
    target_sheet = sheets[0]
    total_rows = max(1, len(matrix) + 1)
    total_cols = max(1, len(headers))
    target_range = f"{target_sheet['sheet_id']}!A1:{excel_col_name(total_cols)}{total_rows}"
    values = [headers, *matrix]
    write_sheet_values_via_feishu(spreadsheet_token, target_range, values)

    style_warning = ""
    if highlighted_positions:
        style_warning = "已导出到飞书表格，并保留“抽样标记”列；整行底色高亮后续可继续补成官方样式接口版本。"

    return {
        "url": spreadsheet_url,
        "spreadsheet_token": spreadsheet_token,
        "sheet_name": target_sheet.get("sheet_name") or "Sheet1",
        "style_warning": style_warning,
        "raw": created,
    }


def create_lark_workbook(title, headers, matrix, highlighted_positions):
    if has_feishu_api_config():
        return create_lark_workbook_via_feishu(title, headers, matrix, highlighted_positions)

    sheet_name = "导出结果"
    payload = {
        "sheets": [
            {
                "name": sheet_name,
                "header": True,
                "columns": headers,
                "data": matrix,
            }
        ]
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8", dir=str(ROOT)) as tmp:
        json.dump(payload, tmp, ensure_ascii=False)
        payload_path = Path(tmp.name)
    try:
        created = run_lark_cli([
            "lark-cli",
            "sheets",
            "+workbook-create",
            "--title",
            title,
            "--sheets",
            f"@./{payload_path.name}",
            "--json",
        ])
    finally:
        payload_path.unlink(missing_ok=True)

    spreadsheet_url = find_first_key(created, {"url", "spreadsheet_url", "sheet_url"})
    spreadsheet_token = find_first_key(created, {"spreadsheet_token", "token"})

    style_warning = ""
    if highlighted_positions and (spreadsheet_url or spreadsheet_token):
        range_end_col = excel_col_name(len(headers))
        target_arg = ["--url", spreadsheet_url] if spreadsheet_url else ["--spreadsheet-token", spreadsheet_token]
        ranges = compact_ranges([position + 2 for position in highlighted_positions])
        if len(ranges) <= 12:
            try:
                for start, end in ranges:
                    style_range = f"A{start}:{range_end_col}{end}"
                    run_lark_cli([
                        "lark-cli",
                        "sheets",
                        "+cells-set-style",
                        *target_arg,
                        "--sheet-name",
                        sheet_name,
                        "--range",
                        style_range,
                        "--background-color",
                        "#DBEAFE",
                        "--font-color",
                        "#1E3A8A",
                        "--json",
                    ])
            except RuntimeError as exc:
                if "frequency limit" in str(exc).lower() or "99991400" in str(exc):
                    style_warning = "飞书上色请求过于频繁，这次保留了“抽样标记”列，但没有继续给整行上底色。"
                else:
                    raise
        else:
            style_warning = "抽中行分段太多，为了避免飞书限流，这次保留了“抽样标记”列，但没有继续给整行上底色。"

    return {
        "url": spreadsheet_url,
        "spreadsheet_token": spreadsheet_token,
        "sheet_name": sheet_name,
        "style_warning": style_warning,
        "raw": created,
    }


def run_lark_cli(args):
    if shutil.which("lark-cli") is None:
        raise RuntimeError(
            "当前服务既没有配置飞书官方 API，也没有安装 lark-cli。"
            "请在部署环境里填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET，或在本地使用已登录的 lark-cli。"
        )
    result = subprocess.run(
        args,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    raw_output = (result.stdout or result.stderr or "").strip()
    payload = None
    if raw_output:
        try:
            payload = json.loads(raw_output)
        except json.JSONDecodeError:
            payload = None
    if result.returncode != 0 and payload is None:
        raise RuntimeError(raw_output or "飞书命令执行失败。")
    try:
        payload = payload or json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("飞书命令返回了无法解析的内容。") from exc
    if not payload.get("ok"):
        error = payload.get("error") or {}
        message = payload.get("msg") or error.get("message") or "飞书接口返回失败。"
        subtype = error.get("subtype") or ""
        code = error.get("code")
        if subtype == "token_expired" or "token expired" in str(message).lower():
            raise RuntimeError("飞书登录状态已过期，请重新授权后再试。")
        if code:
            raise RuntimeError(f"{message}（错误码：{code}）")
        raise RuntimeError(message)
    return payload.get("data", {})


def normalize_sheet_rows(csv_text):
    rows = list(csv.reader(io.StringIO(csv_text or ""), skipinitialspace=True))
    if not rows:
        return []
    header = [str(cell).strip() for cell in rows[0]]
    normalized_rows = []
    for row in rows[1:]:
        if len(row) < len(header):
            row = row + [""] * (len(header) - len(row))
        if len(row) > len(header):
            row = row[: len(header)]
        normalized_row = {
            header[idx] or f"column_{idx + 1}": str(row[idx]).strip()
            for idx in range(len(header))
        }
        if not any(str(value or "").strip() for value in normalized_row.values()):
            continue
        normalized_rows.append(normalized_row)
    return normalized_rows


def parse_json_body(handler):
    content_length = int(handler.headers.get("Content-Length", "0") or "0")
    if content_length <= 0:
        return {}
    body = handler.rfile.read(content_length).decode("utf-8")
    return json.loads(body or "{}")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_file(self, raw, content_type, filename):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/lark/workbook-info":
                payload = parse_json_body(self)
                url = (payload.get("url") or "").strip()
                if not url:
                    return self.send_json({"ok": False, "error": "请先输入飞书表格链接。"}, 400)
                if has_feishu_api_config():
                    spreadsheet_token = parse_spreadsheet_token(url)
                    sheets = fetch_feishu_sheets(spreadsheet_token)
                    data = {
                        "revision": None,
                        "sheets": sheets,
                        "source_url": url,
                        "spreadsheet_token": spreadsheet_token,
                    }
                else:
                    data = run_lark_cli([
                        "lark-cli",
                        "sheets",
                        "+workbook-info",
                        "--url",
                        url,
                        "--json",
                    ])
                return self.send_json({
                    "ok": True,
                    "data": {
                        "revision": data.get("revision"),
                        "sheets": data.get("sheets", []),
                        "source_url": url,
                    }
                })

            if parsed.path == "/api/lark/load-sheet":
                payload = parse_json_body(self)
                url = (payload.get("url") or "").strip()
                sheet_id = (payload.get("sheetId") or "").strip()
                range_text = (payload.get("range") or "").strip()
                if not url:
                    return self.send_json({"ok": False, "error": "请先输入飞书表格链接。"}, 400)
                if not sheet_id:
                    return self.send_json({"ok": False, "error": "请先选择工作表。"}, 400)

                if has_feishu_api_config():
                    spreadsheet_token = parse_spreadsheet_token(url)
                    sheets = fetch_feishu_sheets(spreadsheet_token)
                    target_sheet = next((item for item in sheets if item.get("sheet_id") == sheet_id), None)
                    if not target_sheet:
                        return self.send_json({"ok": False, "error": "没有找到对应的工作表。"}, 404)
                    data = load_sheet_rows_via_feishu(spreadsheet_token, sheet_id, range_text)
                    rows = data.get("rows", [])
                    actual_range = data.get("actual_range")
                    current_region = None
                else:
                    info = run_lark_cli([
                        "lark-cli",
                        "sheets",
                        "+workbook-info",
                        "--url",
                        url,
                        "--json",
                    ])
                    sheets = info.get("sheets", [])
                    target_sheet = next((item for item in sheets if item.get("sheet_id") == sheet_id), None)
                    if not target_sheet:
                        return self.send_json({"ok": False, "error": "没有找到对应的工作表。"}, 404)

                    command = [
                        "lark-cli",
                        "sheets",
                        "+csv-get",
                        "--url",
                        url,
                        "--sheet-id",
                        sheet_id,
                        "--include-row-prefix=false",
                        "--max-chars",
                        "5000000",
                        "--json",
                    ]
                    if range_text:
                        command.extend(["--range", range_text])

                    data = run_lark_cli(command)
                    if data.get("has_more"):
                        return self.send_json({
                            "ok": False,
                            "error": "当前读取范围过大，飞书返回被截断了。请缩小单元格范围后重试。",
                            "data": {
                                "actual_range": data.get("actual_range"),
                                "current_region": data.get("current_region"),
                            }
                        }, 400)
                    rows = normalize_sheet_rows(data.get("annotated_csv", ""))
                    actual_range = data.get("actual_range")
                    current_region = data.get("current_region")
                return self.send_json({
                    "ok": True,
                    "data": {
                        "rows": rows,
                        "actual_range": actual_range or range_text,
                        "current_region": current_region,
                        "sheet": target_sheet,
                        "row_count": target_sheet.get("row_count", 0),
                        "source_url": url,
                    }
                })

            if parsed.path == "/api/export/download":
                payload = parse_json_body(self)
                format_name = (payload.get("format") or "csv").strip().lower()
                mode = (payload.get("mode") or "sampled_only").strip()
                headers = payload.get("headers") or []
                active_rows = payload.get("activeRows") or []
                sampled_row_ids = payload.get("sampledRowIds") or []
                base_name = Path((payload.get("fileName") or "export")).stem
                if not sampled_row_ids:
                    return self.send_json({"ok": False, "error": "当前还没有抽中的记录，请先执行随机抽样。"}, 400)
                dataset = build_export_dataset(headers, active_rows, sampled_row_ids, mode, format_name)
                if format_name == "csv":
                    raw = build_csv_bytes(dataset["headers"], dataset["rows"])
                    return self.send_file(raw, "text/csv; charset=utf-8", f"{base_name}.csv")
                if format_name == "xlsx":
                    raw = build_xlsx_bytes(dataset["headers"], dataset["rows"], dataset["highlighted_positions"])
                    return self.send_file(
                        raw,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        f"{base_name}.xlsx",
                    )
                return self.send_json({"ok": False, "error": "暂不支持该导出格式。"}, 400)

            if parsed.path == "/api/lark/export-sheet":
                payload = parse_json_body(self)
                mode = (payload.get("mode") or "sampled_only").strip()
                headers = payload.get("headers") or []
                active_rows = payload.get("activeRows") or []
                sampled_row_ids = payload.get("sampledRowIds") or []
                title = (payload.get("title") or "抽样导出结果").strip() or "抽样导出结果"
                if not sampled_row_ids:
                    return self.send_json({"ok": False, "error": "当前还没有抽中的记录，请先执行随机抽样。"}, 400)
                dataset = build_export_dataset(headers, active_rows, sampled_row_ids, mode, "lark")
                created = create_lark_workbook(title, dataset["headers"], dataset["matrix"], dataset["highlighted_positions"])
                return self.send_json({"ok": True, "data": created})

            return self.send_json({"ok": False, "error": "接口不存在。"}, 404)
        except json.JSONDecodeError:
            return self.send_json({"ok": False, "error": "请求数据不是合法 JSON。"}, 400)
        except Exception as exc:
            return self.send_json({"ok": False, "error": str(exc)}, 500)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Server running at http://{HOST}:{PORT}")
    server.serve_forever()
