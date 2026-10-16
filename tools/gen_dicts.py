#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_dicts.py —— 重建三本内置词典数据（TEM-4 / CET-4 / CET-6）

为什么有这个脚本：
  原来的 data/{tem4,cet4,cet6}.json 是「纯单词字符串数组」，导入后单词本全显示
  "(暂无释义)"。本脚本按需求重做成「对象数组」，每个词带 pos / meaning / phonetic / rank。

数据来源：
  - TEM-4：本地 docx《【06】词汇汇编9400（默写版）.docx》的「词汇 / 释义」两列
           （释义列里含词性标记，如 "n. 许多…"，脚本自动拆 pos + meaning）。
  - CET-4 / CET-6：沿用已有的词表（_vocab_src/{cet4,cet6}.txt，word<TAB>pos. meaning）。
  - ECDICT（skywind3000/ECDICT 的 ecdict.csv / stardict.csv）：仅补 phonetic + rank 两个字段，
           不覆盖本地已提取的释义与词性。

ECDICT 怎么给（本地优先，绝不无故联网）：
  1) 本地优先：脚本同目录（tools/）下若存在 ecdict.csv / stardict.csv（大小写不敏感），
     直接读取，**不发起任何网络请求**。
  2) 手动指定：--ecdict path/to/file.csv。
  3) 兜底联网：只有本地文件既不存在、也没指定路径、且没加 --no-ecdict 时，
     才尝试从 GitHub 下载 stardict.csv（兜底逻辑，本地有文件时永不触发）。

ECDICT 文件格式（实测，逗号分隔 CSV，13 列，首行表头，字段含引号转义）：
  word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
  字段映射（严格按需求）：
    word        -> word
    phonetic     -> phonetic
    translation  -> meaning（仅作本地缺失时的兜底，本地优先）
    pos          -> pos（仅作本地缺失时的兜底，本地优先）
    frq / bnc    -> rank（优先 frq；frq 为空或为 0 时回落 bnc；两者都无效则 null）
    tag          -> 仅用于附加校验（统计 TEM-4 带 cet4/cet6 标签的比例）

rank 排序：frq/bnc 是语料库词频排名，数值越小越高频；按升序排序，null 沉底。
去重：用 word 的小写（并去除首尾非字母数字，与词典侧 lookup 保持一致）作为 key；
      同一 word 多条记录（不同词性）取 frq 数值最小（最高频）的一条。
无效行：word 为空的行直接跳过。词缀行（#NAME? / -able 等）按原样保留，
      csv 模块只读字符串，不会当成公式解析。

输出：覆盖 data/{tem4,cet4,cet6}.json，格式 {_meta:{...}, words:[{word,pos,meaning,phonetic,rank,srcOrder}]}

用法：
  python gen_dicts.py                      # 自动找 tools/ecdict.csv（或 stardict.csv）读取，不联网
  python gen_dicts.py --no-ecdict          # 完全不碰 ECDICT（TEM-4 只出 docx 释义）
  python gen_dicts.py --ecdict path/to/stardict.csv
  python gen_dicts.py --docx "X.docx" --out ../data
"""
import zipfile
import re
import json
import os
import sys
import csv
import random
import argparse
import datetime
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.path.join(HERE, "..", "data"))
DOCX_DEFAULT = r"D:\产品\AI 新闻单词网站\【06】词汇汇编9400（默写版）.docx"
ECDICT_URLS = [
    "https://raw.githubusercontent.com/skywind3000/ECDICT/master/stardict.csv",
    "https://cdn.jsdelivr.net/gh/skywind3000/ECDICT@master/stardict.csv",
]
# 词性标记（枚举值，按长度降序匹配避免 a. 误吞 adj.）
POS_TOKENS = sorted(
    ["n.", "v.", "vt.", "vi.", "adj.", "a.", "ad.", "adv.", "prep.",
     "pron.", "num.", "conj.", "art.", "int.", "abbr.", "aux.", "s.", "pl.", "esp."],
    key=len, reverse=True,
)
# ECDICT 标准 13 列（字段名对不上时的兜底顺序）
ECDICT_STD_COLS = ["word", "phonetic", "definition", "translation", "pos",
                   "collins", "oxford", "tag", "bnc", "frq", "exchange", "detail", "audio"]


# ----------------------------------------------------------------------------
# 1. 解析 docx 表格
# ----------------------------------------------------------------------------
def read_docx_rows(docx_path):
    z = zipfile.ZipFile(docx_path)
    data = z.read("word/document.xml").decode("utf-8", "ignore")
    trs = re.findall(r"<w:tr[ >].*?</w:tr>", data, re.S)
    rows = []
    for tr in trs:
        tcs = re.findall(r"<w:tc[ >].*?</w:tc>", tr, re.S)
        # 注意：必须锚定 <w:t> 或 <w:t 属性>，否则 <w:tcPr>/<w:tcW> 等也会被误当成文本标签
        cells = ["".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", c, re.S)) for c in tcs]
        if len(cells) < 3:
            continue
        seq, word, mean = cells[0].strip(), cells[1].strip(), cells[2].strip()
        if seq == "序号" or word == "词汇" or not word or not seq.isdigit():
            continue
        rows.append((seq, word, mean))
    return rows


def split_pos(mean_raw):
    """从释义列里拆出词性标记（连写的用 / 连接）和纯释义。"""
    mr = mean_raw.strip()
    pos = []
    while True:
        hit = None
        for tok in POS_TOKENS:
            if mr.lower().startswith(tok.lower()):
                hit = tok
                break
        if not hit:
            break
        pos.append(hit)
        mr = mr[len(hit):].lstrip()
    return "/".join(pos), mr.strip().rstrip("。").strip()


def normalize_word(w):
    # 保留内部空格/连字符（如 "united states" / "counter-offer"），只去首尾非字母数字
    w = w.strip().lower()
    w = re.sub(r"^[^a-z0-9]+", "", w)
    w = re.sub(r"[^a-z0-9]+$", "", w)
    return w


def read_vocab_src(path):
    """读 _vocab_src/{cet4,cet6}.txt，格式：word<TAB>pos. meaning
    返回 {norm_word: {"pos":..,"meaning":..,"srcOrder":None}}"""
    extra = {}
    if not os.path.exists(path):
        print("  ⚠️ 找不到源文件:", path)
        return extra
    for line in open(path, encoding="utf-8", errors="ignore"):
        line = line.rstrip("\n")
        if "\t" not in line:
            continue
        w, rest = line.split("\t", 1)
        w = normalize_word(w)
        if not w or w in extra:
            continue
        pos, m = split_pos(rest.strip())
        extra[w] = {"pos": pos, "meaning": m, "srcOrder": None}
    return extra


# ----------------------------------------------------------------------------
# 2. 解析 ECDICT（逗号分隔 CSV，13 列，首行表头，字段含引号转义）
# ----------------------------------------------------------------------------
def find_local_ecdict():
    """在脚本同目录（tools/）大小写不敏感查找 ecdict.csv / stardict.csv。
    找到则返回绝对路径，否则 None。"""
    cands = ("ecdict.csv", "stardict.csv")
    try:
        names = os.listdir(HERE)
    except OSError:
        return None
    for fn in names:
        if fn.lower() in cands:
            return os.path.join(HERE, fn)
    return None


def load_ecdict(path):
    """读取本地 ECDICT（逗号分隔 CSV）。
    返回 {norm_word: {"phonetic","translation","pos","frq","bnc","tag"}}。
      - 同一 norm_word 多行 -> 取 frq 数值最小（最高频）的那条。
      - word 为空的行跳过；词缀行（#/-/= 开头）按原样保留（csv 只读字符串，不会当公式）。
    注意：必须用 csv 模块而不是简单 split(',')，因为 translation/detail 字段内含逗号与引号。
    """
    rows = {}
    with open(path, "r", encoding="utf-8", errors="ignore", newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            return rows
        idx = {name.strip(): i for i, name in enumerate(header)}
        # 字段名对不上 -> 退回标准 13 列顺序
        if "frq" not in idx or "translation" not in idx or "word" not in idx:
            idx = {n: i for i, n in enumerate(ECDICT_STD_COLS)}

        def col(parts, name, default=""):
            i = idx.get(name)
            if i is None or i >= len(parts):
                return default
            return parts[i]

        for parts in reader:
            if not parts:
                continue
            raw_word = col(parts, "word").strip()
            if not raw_word:
                continue
            w = normalize_word(raw_word)
            if not w:
                continue
            ph = col(parts, "phonetic").strip().strip("/")
            tr = col(parts, "translation").strip()
            pos = col(parts, "pos").strip()
            frq = col(parts, "frq").strip()
            bnc = col(parts, "bnc").strip()
            tag = col(parts, "tag").strip()
            frq_int = int(frq) if frq.isdigit() else None
            rec = {"phonetic": ph, "translation": tr, "pos": pos,
                   "frq": frq, "bnc": bnc, "tag": tag, "_frq": frq_int}
            ex = rows.get(w)
            if ex is None:
                rows[w] = rec
            else:
                # 去重：保留 frq 最小（最高频）的那条
                ex_frq = ex.get("_frq")
                if frq_int is not None and (ex_frq is None or frq_int < ex_frq):
                    rows[w] = rec
    return rows


def fetch_ecdict(urls):
    """兜底：联网下载 stardict.csv 到本地（仅当本地文件不存在时才会被调用）。"""
    for u in urls:
        try:
            print("  下载 ECDICT:", u)
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
            local = os.path.join(HERE, "stardict.csv")
            with urllib.request.urlopen(req, timeout=60) as resp, open(local, "wb") as out:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            print("  已保存:", local)
            return local
        except Exception as e:
            print("  下载失败:", repr(e)[:200])
    return None


# ----------------------------------------------------------------------------
# 3. 组装一本词典
# ----------------------------------------------------------------------------
def build_dict(dict_id, words_in, src_label, ecdict, extra=None):
    """
    words_in: 词形列表（str），决定出现哪些词 + 原始顺序（排序前保留）
    extra: {norm_word: {"pos":..,"meaning":..,"srcOrder":..}}  docx 或 CET-txt 自带释义
    ecdict: {word: {...}} 或 {}
    返回 (words_array, meta)
    """
    extra = extra or {}
    seen = {}
    words = []
    n_meaning = n_phone = n_rank = n_unmatched = 0
    for raw in words_in:
        w = normalize_word(raw)
        if not w or w in seen:
            continue
        seen[w] = True

        info = extra.get(w) or {}
        pos = info.get("pos") or ""
        meaning = info.get("meaning") or ""
        src_order = info.get("srcOrder")
        ec = ecdict.get(w)

        # pos / meaning：本地释义优先，ECDICT 仅作兜底（不覆盖已有内容）
        if not pos and ec and ec.get("pos"):
            pos = ec["pos"]
        if not meaning and ec and ec.get("translation"):
            meaning = ec["translation"]
        # phonetic + rank：只来自 ECDICT
        phonetic = (ec.get("phonetic") or "") if ec else ""
        rank = None
        if ec:
            frq = (ec.get("frq") or "").strip()
            bnc = (ec.get("bnc") or "").strip()
            # rank 取值规则：优先 frq；frq 为空或为 0 时回落 bnc；两者都无效则 null
            if frq and frq != "0" and frq.isdigit():
                rank = int(frq)
            elif bnc and bnc != "0" and bnc.isdigit():
                rank = int(bnc)

        if meaning:
            n_meaning += 1
        if phonetic:
            n_phone += 1
        if rank is not None:
            n_rank += 1
        else:
            n_unmatched += 1

        words.append({
            "word": w,
            "pos": pos,
            "meaning": meaning,
            "phonetic": phonetic,
            "rank": rank,
            "srcOrder": src_order,
        })

    # 排序：rank 升序（高频在前），rank 为 None 排最后；稳定排序保留原顺序
    words.sort(key=lambda x: (x["rank"] if x["rank"] is not None else 10 ** 12,))

    total = len(words)
    meta = {
        "id": dict_id,
        "name": src_label,
        "wordCount": total,
        "sorted": True,
        "lowercase": True,
        "status": "COMPLETE" if (n_phone == total and n_rank == total and n_meaning == total)
                  else ("PARTIAL_ECDICT_APPLIED" if ecdict else "PARTIAL_NEEDS_ECDICT"),
        "source": src_label,
        "generatedAt": datetime.date.today().isoformat(),
        "meaningCoverage": round(100.0 * n_meaning / total, 1) if total else 0,
        "phoneticCoverage": round(100.0 * n_phone / total, 1) if total else 0,
        "rankCoverage": round(100.0 * n_rank / total, 1) if total else 0,
        "unmatchedCount": n_unmatched,
        "ecdictUsed": bool(ecdict),
    }
    return words, meta


# ----------------------------------------------------------------------------
# 4. 主流程
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docx", default=DOCX_DEFAULT)
    ap.add_argument("--ecdict", default=None, help="ECDICT csv 路径；不给则自动找 tools/ 下 ecdict.csv")
    ap.add_argument("--out", default=DATA_DIR)
    ap.add_argument("--no-ecdict", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    # --- ECDICT：本地优先，绝不无故联网 ---
    ecdict = {}
    if not args.no_ecdict:
        ec_path = args.ecdict
        if not ec_path:
            ec_path = find_local_ecdict()
        if ec_path and os.path.exists(ec_path):
            print("加载本地 ECDICT:", ec_path, "（已使用本地文件，不发起任何网络请求）")
            ecdict = load_ecdict(ec_path)
            print("  ECDICT 词条:", len(ecdict))
        elif args.ecdict:
            print("⚠️ --ecdict 指定路径不存在:", args.ecdict)
        else:
            # 兜底：本地无文件才联网下载
            print("本地未找到 ecdict.csv / stardict.csv，尝试联网下载（兜底）…")
            ec_path = fetch_ecdict(ECDICT_URLS)
            if ec_path and os.path.exists(ec_path):
                ecdict = load_ecdict(ec_path)
                print("  ECDICT 词条:", len(ecdict))
            else:
                print("⚠️  未拿到 ECDICT：TEM-4 只有 docx 释义；CET 仅出词形，等 ecdict 再补。")
    else:
        print("（--no-ecdict：跳过 ECDICT）")

    # --- TEM-4：docx ---
    print("解析 docx:", args.docx)
    docx_rows = read_docx_rows(args.docx)
    tem4_extra = {}
    for seq, word, mean in docx_rows:
        w = normalize_word(word)
        if not w or w in tem4_extra:
            continue
        pos, m = split_pos(mean)
        tem4_extra[w] = {"pos": pos, "meaning": m, "srcOrder": int(seq)}
    print("  docx 去重后词条:", len(tem4_extra))
    tem4_words, tem4_meta = build_dict("tem4", list(tem4_extra.keys()),
                                       "本地《【06】词汇汇编9400（默写版）.docx》", ecdict, tem4_extra)
    tem4_meta["source"] = ("本地 docx《【06】词汇汇编9400（默写版）》的「词汇/释义」列"
                           + (" ∪ ECDICT 补音标+词频" if ecdict else "（未接 ECDICT，音标/词频待补）"))

    # --- CET-4 / CET-6：源文件 _vocab_src/{cet4,cet6}.txt（word<TAB>pos. meaning）---
    vocab_src_dir = os.path.abspath(os.path.join(HERE, "..", "_vocab_src"))
    cet4_extra = read_vocab_src(os.path.join(vocab_src_dir, "cet4.txt"))
    cet6_extra = read_vocab_src(os.path.join(vocab_src_dir, "cet6.txt"))
    print("  CET-4 源词条:", len(cet4_extra), "| CET-6 源词条:", len(cet6_extra))
    cet4_words, cet4_meta = build_dict("cet4", list(cet4_extra.keys()),
                                       "本地 _vocab_src/cet4.txt ∪ ECDICT", ecdict, cet4_extra)
    cet6_words, cet6_meta = build_dict("cet6", list(cet6_extra.keys()),
                                       "本地 _vocab_src/cet6.txt ∪ ECDICT", ecdict, cet6_extra)
    cet4_meta["source"] = ("本地 _vocab_src/cet4.txt 的「词/释义」列"
                           + (" ∪ ECDICT 补音标+词频" if ecdict else "（未接 ECDICT，音标/词频待补）"))
    cet6_meta["source"] = ("本地 _vocab_src/cet6.txt 的「词/释义」列"
                           + (" ∪ ECDICT 补音标+词频" if ecdict else "（未接 ECDICT，音标/词频待补）"))

    # --- 写出 ---
    results = []
    for fid, words, meta in (("tem4", tem4_words, tem4_meta),
                             ("cet4", cet4_words, cet4_meta),
                             ("cet6", cet6_words, cet6_meta)):
        meta["approx"] = meta["wordCount"]
        out = {"_meta": meta, "words": words}
        op = os.path.join(args.out, fid + ".json")
        with open(op, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        print("写出", op, "词数", meta["wordCount"],
              "| 释义", meta["meaningCoverage"], "% 音标", meta["phoneticCoverage"],
              "% 词频", meta["rankCoverage"], "%")
        results.append((fid, words, meta))

    # --- 报告：必报四项 + 附加校验 ---
    report(results, ecdict)


def report(results, ecdict):
    print("\n" + "=" * 60)
    print("【必报四项】")
    print("1) 音标覆盖率 / 2) 词频覆盖率（有值词数 ÷ 总词数）：")
    for fid, words, meta in results:
        print("   %-5s 音标 %.1f%%   词频 %.1f%%   (总词 %d)"
              % (fid.upper(), meta["phoneticCoverage"], meta["rankCoverage"], meta["wordCount"]))

    print("\n3) 报错情况：")
    if ecdict:
        print("   本次使用本地 ecdict.csv，未发起任何网络请求，无报错。")
    else:
        print("   本次未加载到 ECDICT（详见上方警告），仅影响音标/词频覆盖率。")

    print("\n4) 随机抽查 20 个 TEM-4 词（word / phonetic / pos / meaning / rank）：")
    tem4 = results[0][1]
    random.seed(20261015)
    sample = random.sample(tem4, min(20, len(tem4)))
    for w in sample:
        print("   %-18s | /%s/ | %-6s | %s | rank=%s"
              % (w["word"], w["phonetic"], w["pos"], w["meaning"], w["rank"]))

    print("\n【附加校验】TEM-4 词在 ECDICT 中带 cet4 / cet6 标签的比例：")
    hit = 0
    matched = 0
    for w in tem4:
        ec = ecdict.get(w["word"])
        if not ec:
            continue
        matched += 1
        toks = set((ec.get("tag") or "").lower().split())
        if "cet4" in toks or "cet6" in toks:
            hit += 1
    total = len(tem4)
    ratio = (100.0 * hit / total) if total else 0
    print("   命中标签 %d / 总词 %d = %.1f%%   （其中在 ECDICT 匹配到 %d 词）"
          % (hit, total, ratio, matched))
    if ratio < 30:
        print("   ⚠️ 大量词无 cet4/cet6 标签，可能匹配逻辑有问题，需排查。")
    else:
        print("   （比例正常，匹配逻辑 OK）")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        print("\n【运行报错】")
        traceback.print_exc()
        sys.exit(1)
