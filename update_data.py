import requests
import json
import os
import time
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ================= 基础配置 =================
BASE_URL = "https://tianyuanzhiyi.com/api"
CACHE_DIR = "data"
os.makedirs(CACHE_DIR, exist_ok=True)

HEADERS = {"x-external-auth": "1145141919810"}

POSITION_MAP = {"0": "对抗路", "1": "中路", "2": "发育路", "3": "打野", "4": "辅助"}
POSITIONS = list(POSITION_MAP.values())
POSITION_TO_NUM = {v: k for k, v in POSITION_MAP.items()}

# 计算目标日期（考虑早上8点前用前两天的数据）
now = datetime.datetime.now()
days_ago = 2 if now.hour < 8 else 1
TARGET_DATE = (now.date() - datetime.timedelta(days=days_ago)).strftime("%Y-%m-%d")

# 配置带重试的 session（短超时，避免卡死）
session = requests.Session()
retry_strategy = Retry(
    total=2,
    backoff_factor=0.3,
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
    """获取 combined 数据，不过滤出场率，返回 (pos_result, wr_result)"""
    url = f"{BASE_URL}/herostats/combined?heroId={hero_id}&date={TARGET_DATE}"
    resp = session.get(url, timeout=8)  # 缩短超时
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
            try:
                wr = float(wr_raw)
                wr = max(0.01, min(0.99, wr / 100 if wr > 1 else wr))
                wr_result[role] = wr
            except (TypeError, ValueError):
                # 如果无法转换（例如字符串 "null"），跳过
                pass
    return pos_result, wr_result

def get_hero_analysis(hero_id):
    url = f"{BASE_URL}/hero/analysis?heroId={hero_id}"
    resp = session.get(url, timeout=8)
    resp.raise_for_status()
    return resp.json()

def get_hero_period(hero_id):
    url = f"{BASE_URL}/detail/specifyheroperiod?heroId={hero_id}"
    resp = session.get(url, timeout=8)
    resp.raise_for_status()
    periods = resp.json().get("winRateByDuration", [])
    return periods

def get_fallback_winrate(hero_id, hero_name, target_position, hero_dict):
    """使用 match/find 接口获取缺失位置的胜率，失败或无效返回 None"""
    fallback_opponents = [
        ("狂铁", "0"),
        ("沈梦溪", "1"),
        ("敖隐", "2"),
        ("裴擒虎", "3"),
        ("少司缘", "4")
    ]
    pos_num = POSITION_TO_NUM.get(target_position)
    if not pos_num:
        return None

    for opp_name, opp_pos_num in fallback_opponents:
        if opp_name not in hero_dict or opp_name == hero_name:
            continue
        try:
            camp1 = {pos_num: hero_id}
            camp2 = {opp_pos_num: hero_dict[opp_name]}
            params = {
                "camp1Heroes": json.dumps(camp1, separators=(',', ':')),
                "camp2Heroes": json.dumps(camp2, separators=(',', ':')),
                "days": 30
            }
            resp = session.get(f"{BASE_URL}/match/find", params=params, timeout=6)
            resp.raise_for_status()
            comps = resp.json().get("heroComparisons", [])
            target_comp = next((c for c in comps if c.get('heroName') == hero_name), None)
            if target_comp:
                raw_wr = target_comp.get("averageWinRate")
                if raw_wr is None:
                    continue
                wr_value = float(raw_wr)
                if wr_value > 1.0:
                    wr_value = wr_value / 100.0
                # 如果胜率极小（< 0.001），视为无数据，不填充
                if wr_value < 0.001:
                    continue
                wr_value = max(0.01, min(0.99, wr_value))
                return wr_value
        except Exception:
            continue
    return None

# ================= 单个英雄处理函数 =================
def process_hero(hero_id, hero_name, hero_dict):
    """处理单个英雄，返回 (hero_id_str, pos_result, wr_result, ana_result, period_result)"""
    hero_id_str = str(hero_id)
    pos_res, wr_res = {}, {}
    ana_res = {"counters": [], "counteredBy": [], "goodSynergies": [], "badSynergies": []}
    period_res = []

    # 获取 combined 数据
    try:
        pos_res, wr_res = get_hero_combined(hero_id)
    except Exception as e:
        print(f"⚠️ {hero_name} 获取 combined 失败: {e}")

    # 获取 analysis 数据
    try:
        ana_res = get_hero_analysis(hero_id)
    except Exception as e:
        print(f"⚠️ {hero_name} 获取 analysis 失败: {e}")

    # 获取 period 数据
    try:
        period_res = get_hero_period(hero_id)
    except Exception as e:
        print(f"⚠️ {hero_name} 获取 period 失败: {e}")

    # 填充缺失胜率（只对 combined 中确实没有胜率的位置）
    missing_positions = [pos for pos in POSITIONS if pos not in wr_res]
    for pos in missing_positions:
        fallback_wr = get_fallback_winrate(hero_id, hero_name, pos, hero_dict)
        if fallback_wr is not None:
            wr_res[pos] = fallback_wr
            print(f"✅ 填充 {hero_name} 在 {pos} 的胜率: {fallback_wr:.4f}")

    return hero_id_str, pos_res, wr_res, ana_res, period_res

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

    # 3. 并发处理所有英雄
    pos_cache = {}
    wr_cache = {}
    ana_cache = {}
    period_cache = {}

    hero_items = list(hero_dict.items())  # [(name, id), ...]
    total = len(hero_items)

    # 使用线程池并发，最大 8 个线程
    with ThreadPoolExecutor(max_workers=8) as executor:
        future_to_hero = {
            executor.submit(process_hero, hero_id, hero_name, hero_dict): (hero_name, hero_id)
            for hero_name, hero_id in hero_items
        }
        completed = 0
        for future in as_completed(future_to_hero):
            hero_name, hero_id = future_to_hero[future]
            try:
                hero_id_str, pos_res, wr_res, ana_res, period_res = future.result()
                pos_cache[hero_id_str] = pos_res
                wr_cache[hero_id_str] = wr_res
                ana_cache[hero_id_str] = ana_res
                period_cache[hero_id_str] = period_res
                completed += 1
                print(f"进度：{completed}/{total} - {hero_name} 完成")
            except Exception as e:
                print(f"❌ {hero_name} 处理失败: {e}")
                # 写入空数据防止缺失
                hero_id_str = str(hero_id)
                pos_cache[hero_id_str] = {}
                wr_cache[hero_id_str] = {}
                ana_cache[hero_id_str] = {"counters": [], "counteredBy": [], "goodSynergies": [], "badSynergies": []}
                period_cache[hero_id_str] = []

    # 4. 保存所有缓存文件
    save_json(os.path.join(CACHE_DIR, "position_cache.json"), pos_cache)
    save_json(os.path.join(CACHE_DIR, "win_rate_cache.json"), wr_cache)
    save_json(os.path.join(CACHE_DIR, "hero_analysis_cache.json"), ana_cache)
    save_json(os.path.join(CACHE_DIR, "hero_period_cache.json"), period_cache)

    print("✅ 数据更新完成！")

if __name__ == "__main__":
    main()
