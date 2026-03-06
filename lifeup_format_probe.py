import argparse
import json
import os
from urllib.parse import quote

import requests


def load_proxy_config(repo_root):
    config_path = os.path.join(repo_root, "funcs_config.json")
    default_config = {
        "host": "192.168.105.21",
        "port": 13276,
        "timeout": 15,
    }

    if not os.path.exists(config_path):
        return default_config

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            user_config = json.load(f)
        merged = dict(default_config)
        merged.update(user_config)
        return merged
    except Exception:
        return default_config


def build_proxy_url(base_url, target_url):
    encoded_url = quote(target_url, safe="")
    return f"{base_url.rstrip('/')}/api/contentprovider?url={encoded_url}"


def call_lifeup(base_url, target_url, timeout):
    url = build_proxy_url(base_url, target_url)
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    return response.json()


def unwrap_cloud_response(payload):
    if not isinstance(payload, dict):
        return payload
    if "code" not in payload or "data" not in payload or not isinstance(payload.get("data"), list):
        return payload

    data_list = payload.get("data") or []
    if len(data_list) == 0:
        return {}
    if len(data_list) == 1:
        item = data_list[0]
        if isinstance(item, dict) and "result" in item:
            return item.get("result")
        return item

    result = []
    for item in data_list:
        if isinstance(item, dict) and "result" in item:
            result.append(item.get("result"))
        else:
            result.append(item)
    return result


def infer_type(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "dict"
    return type(value).__name__


def print_schema(label, payload):
    print(f"\n=== {label} ===")
    print("raw:")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if not isinstance(payload, dict):
        print(f"schema: <non-dict> {infer_type(payload)}")
        return
    print("schema:")
    for key in sorted(payload.keys()):
        print(f"- {key}: {infer_type(payload[key])}")


def print_effective_schema(label, payload):
    effective = unwrap_cloud_response(payload)
    print(f"effective schema ({label}):")
    if not isinstance(effective, dict):
        print(f"- <root>: {infer_type(effective)}")
        return effective
    for key in sorted(effective.keys()):
        print(f"- {key}: {infer_type(effective[key])}")
    return effective


def check_query_coin(payload):
    payload = unwrap_cloud_response(payload)
    value = payload.get("value") if isinstance(payload, dict) else None
    ok = isinstance(value, (int, float, str))
    return ok, "推荐读取字段: value (number/string)"


def check_query_tomato(payload):
    payload = unwrap_cloud_response(payload)
    if not isinstance(payload, dict):
        return False, "tomato 返回不是对象"
    keys = ["available", "total", "exchanged"]
    missing = [k for k in keys if k not in payload]
    return len(missing) == 0, f"推荐读取字段: {', '.join(keys)}"


def check_query_skill(payload):
    payload = unwrap_cloud_response(payload)
    if not isinstance(payload, dict):
        return False, "query_skill 返回不是对象"
    keys = ["name", "level", "total_exp", "until_next_level_exp", "current_level_exp"]
    missing = [k for k in keys if k not in payload]
    if missing:
        return False, f"缺少字段: {', '.join(missing)}"
    return True, "字段完整"


def main():
    parser = argparse.ArgumentParser(description="LifeUp -> Obsidian 数据格式探测脚本")
    parser.add_argument("--base-url", help="云人升基础地址，例如 http://127.0.0.1:8080")
    parser.add_argument("--timeout", type=int, default=None, help="请求超时秒数")
    parser.add_argument("--skill-start", type=int, default=1, help="query_skill 起始ID")
    parser.add_argument("--skill-end", type=int, default=6, help="query_skill 结束ID")
    args = parser.parse_args()

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    cfg = load_proxy_config(repo_root)
    base_url = args.base_url or f"http://{cfg.get('host', 'localhost')}:{cfg.get('port', 8080)}"
    timeout = args.timeout if args.timeout is not None else int(cfg.get("timeout", 15))

    print(f"Using base url: {base_url}")
    print(f"Timeout: {timeout}s")

    probes = [
        ("query?key=coin", "lifeup://api/query?key=coin", check_query_coin),
        ("query?key=tomato", "lifeup://api/query?key=tomato", check_query_tomato),
    ]

    for label, target, checker in probes:
        try:
            data = call_lifeup(base_url, target, timeout)
            print_schema(label, data)
            print_effective_schema(label, data)
            ok, msg = checker(data)
            print(f"check: {'PASS' if ok else 'WARN'} - {msg}")
        except Exception as exc:
            print(f"\n=== {label} ===")
            print(f"ERROR: {exc}")

    for skill_id in range(args.skill_start, args.skill_end + 1):
        label = f"query_skill?id={skill_id}"
        target = f"lifeup://api/query_skill?id={skill_id}"
        try:
            data = call_lifeup(base_url, target, timeout)
            print_schema(label, data)
            print_effective_schema(label, data)
            ok, msg = check_query_skill(data)
            print(f"check: {'PASS' if ok else 'WARN'} - {msg}")
        except Exception as exc:
            print(f"\n=== {label} ===")
            print(f"ERROR: {exc}")


if __name__ == "__main__":
    main()
