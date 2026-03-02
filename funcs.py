import requests
import json
import os
from urllib.parse import quote

"""
lifeup的一堆接口，其实就是python调用http请求……

// 单一调用（content provider 形式）
http://{host:port}/api/contentprovider?url=YOUR_ENCODED_API_URL

// 批量调用
http://{host:port}/api/contentprovider?url=YOUR_ENCODED_API_URL_1&url=YOUR_ENCODED_API_URL_2

// 单一调用（start activity形式）
http://{host:port}/api?url=YOUR_ENCODED_API_URL
"""

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "funcs_config.json")


def load_funcs_config():
    default_config = {
        "host": "localhost",
        "port": 8080,
        "timeout": 30,
        "gold_item_id": 5
    }

    if not os.path.exists(CONFIG_PATH):
        return default_config

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user_config = json.load(f)
    except Exception:
        return default_config

    merged_config = dict(default_config)
    merged_config.update(user_config)
    return merged_config


CONFIG = load_funcs_config()

# 查询
def call_content_provider(target_url):
    """
    单一调用：通过代理访问目标 API
    """
    # URL 需要编码（特殊字符转义）
    encoded_url = quote(target_url, safe='')
    
    host = CONFIG.get("host")
    port = CONFIG.get("port")
    timeout = CONFIG.get("timeout")

    proxy_url = f"http://{host}:{port}/api/contentprovider?url={encoded_url}"
    
    try:
        response = requests.get(proxy_url, timeout=timeout)
        response.raise_for_status()
        return response.json()  # 或 response.text 看返回格式
    except requests.RequestException as exc:
        raise RuntimeError(f"请求失败: {exc}") from exc

def ask_coin():
    """查询当前的硬币数量"""
    result = call_content_provider("lifeup://api/query?key=coin")
    return result.get("coin")

def ask_tomato_available():
    """查询当前的可用番茄数量"""
    result = call_content_provider("lifeup://api/query?key=tomato")
    return result.get("available")

def ask_tomato_total():
    """查询当前的总番茄数量"""
    result = call_content_provider("lifeup://api/query?key=tomato_total")
    return result.get("total")

def ask_gold():
    """查询当前的金币数量，初次使用需要自行修改金币的商品id，自动查询待补完"""
    gold_item_id = CONFIG.get("gold_item_id")
    result = call_content_provider(f"lifeup://api/query?key=item&item_id={gold_item_id}")
    return result.get("own_number")

# 操作
def add_coin(amount):
    """增加硬币"""
    return call_content_provider(f"lifeup://api/reward?type=coin&number={amount}")

def add_item(item_id, amount):
    """增加指定物品"""
    return call_content_provider(f"lifeup://api/reward?type=item&item_id={item_id}&number={amount}")

def add_gold(amount):
    """增加金币，初次使用需要自行修改金币的商品id，自动查询待补完"""
    gold_item_id = CONFIG.get("gold_item_id")
    return add_item(gold_item_id, amount)

def add_tomato(amount):
    """增加番茄"""
    return call_content_provider(f"lifeup://api/tomato?action=increase&number={amount}")
def reduce_tomato(amount):
    """减少番茄"""
    return call_content_provider(f"lifeup://api/tomato?action=decrease&number={amount}")

def add_task(title, description="", gold=0):
    """添加任务"""
    return call_content_provider(f"lifeup://api/add_task?todo=={quote(title)}&notes=={quote(description)}&category=0&item_name=金币&gold={gold}")

# 池子（或者长期持续投入的目标？）
def add_pool(title, description="", gold=0):
    """添加池子"""
    pool_num = call_content_provider(f"")
    return call_content_provider(f"lifeup://api/add_task?todo=={quote(title)}&notes=={quote(description)}&category=0&item_name=金币&gold={gold}")

# 委托，算了等会再写
def add_wish(title, description="", gold=0):
    """添加委托，话说这玩意为什么叫委托啊，不如说是一个手工banner"""
    return call_content_provider(f"lifeup://api/wish/add?title={quote(title)}&description={quote(description)}&gold={gold}")