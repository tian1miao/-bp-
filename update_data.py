import requests
import json
import os
import time
import datetime
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ================= 基础配置 =================
BASE_URL = "https://tianyuanzhiyi.com/api"
CACHE_DIR = "data"
os.makedirs(CACHE_DIR, exist_ok=True)

HEADERS = {"x-external-auth": "1145141919810"}

POSITION_MAP = {"0": "对抗路", "1": "中路", "2": "发育路", "3": "打野", "4": "辅助"}

# 计算目标日期（考虑早上8点前用前两天的数据）
now = datetime.datetime.now()
days_ago = 2 if now.hour < 8 else 1
TARGET_DATE = (now.date() - datetime.timedelta(days=days_ago)).strftime("%Y-%m-%d")

# 配置带重试的 session
session = requests.Session()
retry_strategy = Retry(
    total=2,
    backoff_factor=0.5,
    status_forcelist=[429, 500, 502, 503, 504],
)
adapter = HTTPAdapter(max_retries=retry_strategy)
session.mount("http://", adapter)
session.mount("https://", adapter)
session.headers.update(HEADERS)

# ================= 工具函数 =================
def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def load_json(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

# ================= API 请求函数 =================
def get_all_heroes():
    resp = session.get(f"{BASE_URL}/allheroes", timeout=15)
    resp.raise_for_status()
    heroes = resp.json()
    hero_dict = {h["name"]: h["id"] for h in heroes}
    return hero_dict

def get_global_winrate():
    try:
        resp = session.get(f"{BASE_URL}/global/winrate?date={TARGET_DATE}", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        blue = float(data.get("blueTeamWinRate", 50.45))
        red = float(data.get("redTeamWinRate", 100 - blue))
        return {TARGET_DATE: {"blue": blue, "red": red}}
    except Exception:
        return {TARGET_DATE: {"blue": 50.0, "red": 50.0}}

def get_hero_combined(hero_id):
    url = f"{BASE_URL}/herostats/combined?heroId={hero_id}&date={TARGET_DATE}"
    resp = session.get(url, timeout=10)
    resp.raise_for_status()
    data = resp.json().get("positions", {})
    pos_result = {}
    wr_result = {}
    for key, value in data.items():
        role = POSITION_MAP.get(key)
        if not role:
            continue
        # 保存出场率（不过滤）
        pick_raw = value.get("pickRate")
        if pick_raw is not None:
            pos_result[role] = round(float(pick_raw), 2)
        # 保存胜率（转换到0-1区间）
        wr_raw = value.get("winRate")
        if wr_raw is not None:
            wr = float(wr_raw)
            wr = max(0.01, min(0.99, wr / 100 if wr > 1 else wr))
            wr_result[role] = wr
    return pos_result, wr_result

def get_hero_analysis(hero_id):
    url = f"{BASE_URL}/hero/analysis?heroId={hero_id}"
    resp = session.get(url, timeout=10)
    resp.raise_for_status()
    return resp.json()

def get_hero_period(hero_id):
    url = f"{BASE_URL}/detail/specifyheroperiod?heroId={hero_id}"
    resp = session.get(url, timeout=10)
    resp.raise_for_status()
    periods = resp.json().get("winRateByDuration", [])
    return periods

# ================= 主函数 =================
def main():
    print("开始更新数据...")

    # 1. 获取英雄列表
    hero_dict = get_all_heroes()
    save_json(os.path.join(CACHE_DIR, "hero_list.json"), hero_dict)
    print(f"英雄数量：{len(hero_dict)}")

    # 2. 获取全局胜率
    global_wr = get_global_winrate()
    global_path = os.path.join(CACHE_DIR, "global_win_rate_cache.json")
    old_global = load_json(global_path)
    old_global.update(global_wr)
    save_json(global_path, old_global)
    print(f"全局胜率更新完成：{global_wr}")

    # 3. 遍历所有英雄获取详细数据
    pos_cache = {}
    wr_cache = {}
    ana_cache = {}
    period_cache = {}

    hero_ids = list(hero_dict.values())
    total = len(hero_ids)

    for i, hero_id in enumerate(hero_ids):
        hero_id_str = str(hero_id)
        hero_name = next((name for name, hid in hero_dict.items() if hid == hero_id), str(hero_id))
        print(f"处理 {i+1}/{total}: {hero_name} (id={hero_id})")

        # 初始化默认值
        pos_res, wr_res = {}, {}
        ana_res = {"counters": [], "counteredBy": [], "goodSynergies": [], "badSynergies": []}
        period_res = []

        # 获取 combined 数据（不过滤出场率，不填充缺失胜率）
        try:
            pos_res, wr_res = get_hero_combined(hero_id)
        except Exception as e:
            print(f"  ⚠️ 获取 combined 失败: {e}")

        # 获取 analysis 数据
        try:
            ana_res = get_hero_analysis(hero_id)
        except Exception as e:
            print(f"  ⚠️ 获取 analysis 失败: {e}")

        # 获取 period 数据
        try:
            period_res = get_hero_period(hero_id)
        except Exception as e:
            print(f"  ⚠️ 获取 period 失败: {e}")

        # 写入缓存字典
        pos_cache[hero_id_str] = pos_res
        wr_cache[hero_id_str] = wr_res
        ana_cache[hero_id_str] = ana_res
        period_cache[hero_id_str] = period_res

        # 短暂延时，避免请求过快
        time.sleep(0.1)

    # 保存所有缓存文件
    save_json(os.path.join(CACHE_DIR, "position_cache.json"), pos_cache)
    save_json(os.path.join(CACHE_DIR, "win_rate_cache.json"), wr_cache)
    save_json(os.path.join(CACHE_DIR, "hero_analysis_cache.json"), ana_cache)
    save_json(os.path.join(CACHE_DIR, "hero_period_cache.json"), period_cache)

    print("✅ 数据更新完成！")

if __name__ == "__main__":
    main()
