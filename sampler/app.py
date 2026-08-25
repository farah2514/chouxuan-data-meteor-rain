import csv
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import hashlib
import base64
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse, urlencode, parse_qsl
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
FEISHU_AUTHORIZE_URL = (os.environ.get("FEISHU_AUTHORIZE_URL") or "https://accounts.feishu.cn/open-apis/authen/v1/authorize").rstrip("/")
FEISHU_OAUTH_TOKEN_URL = (os.environ.get("FEISHU_OAUTH_TOKEN_URL") or "https://accounts.feishu.cn/oauth/v3/token").rstrip("/")
FEISHU_REDIRECT_URI = (os.environ.get("FEISHU_REDIRECT_URI") or "").strip()
FEISHU_OAUTH_SCOPE = (os.environ.get("FEISHU_OAUTH_SCOPE") or "offline_access sheets:spreadsheet").strip()
SESSION_COOKIE_NAME = "sampler_session"
TOKEN_CACHE = {
    "tenant_access_token": "",
    "expire_at": 0,
}
SESSION_STORE = {}


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


def get_cookie_dict(handler):
    cookie_header = handler.headers.get("Cookie") or ""
    cookies = {}
    for chunk in cookie_header.split(";"):
        if "=" not in chunk:
            continue
        key, value = chunk.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies


def is_secure_request(handler):
    forwarded_proto = (handler.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip().lower()
    if forwarded_proto:
        return forwarded_proto == "https"
    origin = (handler.headers.get("Origin") or "").strip().lower()
    return origin.startswith("https://")


def get_external_origin(handler):
    forwarded_host = (handler.headers.get("X-Forwarded-Host") or "").split(",", 1)[0].strip()
    host = forwarded_host or (handler.headers.get("Host") or "").strip() or f"127.0.0.1:{PORT}"
    forwarded_proto = (handler.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip().lower()
    proto = forwarded_proto or ("https" if is_secure_request(handler) else "http")
    return f"{proto}://{host}"


def get_oauth_redirect_uri(handler):
    return FEISHU_REDIRECT_URI or f"{get_external_origin(handler)}/api/lark/auth/callback"


def get_safe_next_path(raw_value):
    value = (raw_value or "").strip()
    if not value:
        return "/?tab=sampler"
    parsed = urlparse(value)
    if parsed.scheme or parsed.netloc:
        return "/?tab=sampler"
    if not value.startswith("/"):
        return "/?tab=sampler"
    return value


def build_cookie_header(name, value, *, max_age=None, secure=False):
    parts = [f"{name}={value}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if max_age is not None:
        parts.append(f"Max-Age={int(max_age)}")
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def get_session(handler, create=False):
    session_id = get_cookie_dict(handler).get(SESSION_COOKIE_NAME)
    if session_id and session_id in SESSION_STORE:
        return session_id, SESSION_STORE[session_id], None
    if not create:
        return "", None, None
    session_id = secrets.token_urlsafe(24)
    session = {"created_at": int(time.time())}
    SESSION_STORE[session_id] = session
    cookie = build_cookie_header(
        SESSION_COOKIE_NAME,
        session_id,
        max_age=60 * 60 * 24 * 30,
        secure=is_secure_request(handler),
    )
    return session_id, session, cookie


def clear_session(handler):
    session_id = get_cookie_dict(handler).get(SESSION_COOKIE_NAME)
    if session_id:
        SESSION_STORE.pop(session_id, None)
    return build_cookie_header(
        SESSION_COOKIE_NAME,
        "",
        max_age=0,
        secure=is_secure_request(handler),
    )


def generate_code_verifier():
    return secrets.token_urlsafe(64).rstrip("=")


def generate_code_challenge(verifier):
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


def parse_feishu_auth_error(error_code, error_description):
    raw_code = str(error_code or "").strip()
    raw_description = str(error_description or "").strip()
    text = f"{raw_code} {raw_description}".strip().lower()
    if raw_code == "access_denied":
        return "你取消了飞书授权。"
    if "20027" in text:
        return "飞书应用还没开通当前需要的权限，请先到开放平台里申请对应的表格权限。"
    if "20010" in text:
        return "当前用户没有这个飞书应用的使用权限，请先让管理员开放应用可见范围。"
    if "20071" in text:
        return "飞书回调地址不匹配，请检查开放平台里配置的重定向 URL 是否和当前网址一致。"
    if raw_description:
        return f"飞书授权失败：{raw_description}"
    return "飞书授权失败，请稍后重试。"


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
    if code in {20005, 99991679}:
        return "飞书授权已失效或缺少权限，请重新连接飞书并重新授权。"
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


def get_user_access_token_by_code(handler, code, code_verifier):
    status, payload = http_json_request(
        "POST",
        FEISHU_OAUTH_TOKEN_URL,
        {
            "grant_type": "authorization_code",
            "client_id": FEISHU_APP_ID,
            "client_secret": FEISHU_APP_SECRET,
            "code": code,
            "redirect_uri": get_oauth_redirect_uri(handler),
            "code_verifier": code_verifier,
        },
    )
    if status >= 400 or payload.get("code") != 0:
        raise RuntimeError(parse_feishu_auth_error(payload.get("error") or payload.get("code"), payload.get("error_description") or payload.get("msg")))
    return payload


def refresh_user_access_token(session):
    refresh_token = (session or {}).get("refresh_token") or ""
    if not refresh_token:
        raise RuntimeError("飞书授权已过期，请重新连接飞书。")
    status, payload = http_json_request(
        "POST",
        FEISHU_OAUTH_TOKEN_URL,
        {
            "grant_type": "refresh_token",
            "client_id": FEISHU_APP_ID,
            "client_secret": FEISHU_APP_SECRET,
            "refresh_token": refresh_token,
        },
    )
    if status >= 400 or payload.get("code") != 0:
        raise RuntimeError(parse_feishu_auth_error(payload.get("error") or payload.get("code"), payload.get("error_description") or payload.get("msg")))
    apply_user_token_payload(session, payload)
    return session.get("user_access_token") or ""


def fetch_user_info(access_token):
    data = feishu_api_request(
        "GET",
        "/open-apis/authen/v1/user_info",
        access_token=access_token,
    )
    return data


def apply_user_token_payload(session, payload):
    now = time.time()
    session["user_access_token"] = (payload.get("access_token") or "").strip()
    session["user_access_expire_at"] = int(now + int(payload.get("expires_in") or 7200))
    refresh_token = (payload.get("refresh_token") or "").strip()
    if refresh_token:
        session["refresh_token"] = refresh_token
        session["refresh_expire_at"] = int(now + int(payload.get("refresh_token_expires_in") or 0))
    session["scope"] = (payload.get("scope") or "").strip()
    session["token_type"] = (payload.get("token_type") or "Bearer").strip()
    session["authorized_at"] = int(now)


def get_session_user_access_token(handler, allow_refresh=True):
    _, session, _ = get_session(handler, create=False)
    if not session:
        return "", None
    token = (session.get("user_access_token") or "").strip()
    expire_at = int(session.get("user_access_expire_at") or 0)
    if token and time.time() < max(expire_at - 300, 0):
        return token, session
    if allow_refresh and has_feishu_api_config() and (session.get("refresh_token") or ""):
        token = refresh_user_access_token(session)
        return token, session
    return "", session


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


def feishu_api_request(method, path, payload=None, timeout=30, access_token=""):
    token = access_token or get_tenant_access_token()
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


def fetch_feishu_sheets(spreadsheet_token, access_token=""):
    data = feishu_api_request(
        "GET",
        f"/open-apis/sheets/v3/spreadsheets/{quote(spreadsheet_token)}/sheets/query",
        access_token=access_token,
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


def load_sheet_rows_via_feishu(spreadsheet_token, sheet_id, range_text="", access_token=""):
    full_range = feishu_range_text(sheet_id, range_text)
    data = feishu_api_request(
        "GET",
        f"/open-apis/sheets/v2/spreadsheets/{quote(spreadsheet_token)}/values/{quote(full_range, safe='')}",
        access_token=access_token,
    )
    value_range = data.get("valueRange") or data.get("data") or {}
    values = value_range.get("values") or []
    return {
        "rows": matrix_to_object_rows(values),
        "actual_range": value_range.get("range") or full_range,
    }


def write_sheet_values_via_feishu(spreadsheet_token, range_text, values, access_token=""):
    feishu_api_request(
        "PUT",
        f"/open-apis/sheets/v2/spreadsheets/{quote(spreadsheet_token)}/values",
        payload={
            "valueRange": {
                "range": range_text,
                "values": values,
            }
        },
        access_token=access_token,
    )


def create_lark_workbook_via_feishu(title, headers, matrix, highlighted_positions, access_token=""):
    payload = {"title": title}
    if FEISHU_FOLDER_TOKEN:
        payload["folder_token"] = FEISHU_FOLDER_TOKEN
    created = feishu_api_request(
        "POST",
        "/open-apis/sheets/v3/spreadsheets",
        payload=payload,
        access_token=access_token,
    )
    spreadsheet = created.get("spreadsheet") or {}
    spreadsheet_token = spreadsheet.get("spreadsheet_token") or ""
    spreadsheet_url = spreadsheet.get("url") or ""
    sheets = fetch_feishu_sheets(spreadsheet_token, access_token=access_token)
    if not sheets:
        raise RuntimeError("飞书表格已创建，但没有拿到默认工作表信息。")
    target_sheet = sheets[0]
    total_rows = max(1, len(matrix) + 1)
    total_cols = max(1, len(headers))
    target_range = f"{target_sheet['sheet_id']}!A1:{excel_col_name(total_cols)}{total_rows}"
    values = [headers, *matrix]
    write_sheet_values_via_feishu(spreadsheet_token, target_range, values, access_token=access_token)

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


def create_lark_workbook(title, headers, matrix, highlighted_positions, access_token=""):
    if access_token or has_feishu_api_config():
        return create_lark_workbook_via_feishu(title, headers, matrix, highlighted_positions, access_token=access_token)

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

    def send_json(self, payload, status=200, extra_headers=None):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (extra_headers or []):
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def send_file(self, raw, content_type, filename):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(raw)

    def send_redirect(self, location, extra_headers=None):
        self.send_response(302)
        self.send_header("Location", location)
        for key, value in (extra_headers or []):
            self.send_header(key, value)
        self.end_headers()

    def get_effective_feishu_context(self):
        user_access_token, session = get_session_user_access_token(self)
        if user_access_token:
            return {
                "mode": "user",
                "access_token": user_access_token,
                "session": session,
            }
        if has_feishu_api_config():
            return {
                "mode": "tenant",
                "access_token": "",
                "session": None,
            }
        return {
            "mode": "cli",
            "access_token": "",
            "session": None,
        }

    def handle_auth_status(self):
        authorized = False
        user = None
        scope = ""
        error = ""
        try:
            token, session = get_session_user_access_token(self)
            authorized = bool(token and session)
            if session:
                user = session.get("user_info")
                scope = session.get("scope") or ""
        except Exception as exc:
            error = str(exc)
        return self.send_json({
            "ok": True,
            "data": {
                "configured": has_feishu_api_config(),
                "authorized": authorized,
                "scope": scope,
                "user": user,
                "redirect_uri": get_oauth_redirect_uri(self),
                "default_scope": FEISHU_OAUTH_SCOPE,
                "error": error,
            }
        })

    def handle_auth_start(self, parsed):
        if not has_feishu_api_config():
            return self.send_json({
                "ok": False,
                "error": "服务端还没有配置飞书应用，请先填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET。"
            }, 400)
        _, session, cookie_header = get_session(self, create=True)
        state = secrets.token_urlsafe(24)
        verifier = generate_code_verifier()
        next_path = get_safe_next_path(dict(parse_qsl(parsed.query)).get("next") or "/?tab=sampler")
        session["oauth_state"] = state
        session["oauth_code_verifier"] = verifier
        session["oauth_next_path"] = next_path
        authorize_url = (
            FEISHU_AUTHORIZE_URL
            + "?"
            + urlencode({
                "client_id": FEISHU_APP_ID,
                "response_type": "code",
                "redirect_uri": get_oauth_redirect_uri(self),
                "scope": FEISHU_OAUTH_SCOPE,
                "state": state,
                "prompt": "consent",
                "code_challenge": generate_code_challenge(verifier),
                "code_challenge_method": "S256",
            })
        )
        headers = [("Set-Cookie", cookie_header)] if cookie_header else []
        return self.send_redirect(authorize_url, headers)

    def handle_auth_callback(self, parsed):
        params = dict(parse_qsl(parsed.query, keep_blank_values=True))
        _, session, cookie_header = get_session(self, create=True)
        headers = [("Set-Cookie", cookie_header)] if cookie_header else []
        next_path = get_safe_next_path((session or {}).get("oauth_next_path") or "/?tab=sampler")

        if params.get("error"):
            error_message = parse_feishu_auth_error(params.get("error"), params.get("error_description"))
            target = f"{next_path}{'&' if '?' in next_path else '?'}larkAuth=error&message={quote(error_message)}"
            return self.send_redirect(target, headers)

        expected_state = (session or {}).get("oauth_state") or ""
        if not expected_state or params.get("state") != expected_state:
            target = f"{next_path}{'&' if '?' in next_path else '?'}larkAuth=error&message={quote('飞书授权状态校验失败，请重新连接。')}"
            return self.send_redirect(target, headers)

        code = (params.get("code") or "").strip()
        if not code:
            target = f"{next_path}{'&' if '?' in next_path else '?'}larkAuth=error&message={quote('飞书没有返回授权码，请重新授权。')}"
            return self.send_redirect(target, headers)

        try:
            token_payload = get_user_access_token_by_code(self, code, session.get("oauth_code_verifier") or "")
            apply_user_token_payload(session, token_payload)
            user_info = fetch_user_info(session.get("user_access_token") or "")
            session["user_info"] = user_info
            session.pop("oauth_state", None)
            session.pop("oauth_code_verifier", None)
            session["oauth_next_path"] = next_path
            target = f"{next_path}{'&' if '?' in next_path else '?'}larkAuth=success"
            return self.send_redirect(target, headers)
        except Exception as exc:
            target = f"{next_path}{'&' if '?' in next_path else '?'}larkAuth=error&message={quote(str(exc))}"
            return self.send_redirect(target, headers)

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/lark/auth/status":
                return self.handle_auth_status()
            if parsed.path == "/api/lark/auth/start":
                return self.handle_auth_start(parsed)
            if parsed.path == "/api/lark/auth/callback":
                return self.handle_auth_callback(parsed)
            return super().do_GET()
        except Exception as exc:
            return self.send_json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/lark/auth/logout":
                cookie = clear_session(self)
                return self.send_json({"ok": True}, 200, extra_headers=[("Set-Cookie", cookie)])

            if parsed.path == "/api/lark/workbook-info":
                payload = parse_json_body(self)
                url = (payload.get("url") or "").strip()
                if not url:
                    return self.send_json({"ok": False, "error": "请先输入飞书表格链接。"}, 400)
                auth_context = self.get_effective_feishu_context()
                if auth_context["mode"] in {"user", "tenant"}:
                    spreadsheet_token = parse_spreadsheet_token(url)
                    sheets = fetch_feishu_sheets(spreadsheet_token, access_token=auth_context["access_token"])
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

                auth_context = self.get_effective_feishu_context()
                if auth_context["mode"] in {"user", "tenant"}:
                    spreadsheet_token = parse_spreadsheet_token(url)
                    sheets = fetch_feishu_sheets(spreadsheet_token, access_token=auth_context["access_token"])
                    target_sheet = next((item for item in sheets if item.get("sheet_id") == sheet_id), None)
                    if not target_sheet:
                        return self.send_json({"ok": False, "error": "没有找到对应的工作表。"}, 404)
                    data = load_sheet_rows_via_feishu(
                        spreadsheet_token,
                        sheet_id,
                        range_text,
                        access_token=auth_context["access_token"],
                    )
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
                auth_context = self.get_effective_feishu_context()
                created = create_lark_workbook(
                    title,
                    dataset["headers"],
                    dataset["matrix"],
                    dataset["highlighted_positions"],
                    access_token=auth_context["access_token"],
                )
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
