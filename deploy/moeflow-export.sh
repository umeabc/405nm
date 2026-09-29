#!/usr/bin/env bash
#
# 从旧站（moeflow / 彩翻）的 MongoDB 里**只读**导出一份 EJSON 快照，供 405nm 的迁移工具读取。
#
# 用法：
#   ./deploy/moeflow-export.sh <输出目录> [容器名]
#
# 只读保证：
#   - `mongoexport` 只发 find，不写任何东西；`countDocuments` 同理；
#   - 全部走 `docker exec`，容器里不留文件，字节直接落到宿主的输出目录；
#   - 凭据取自**容器自己的环境变量**（在容器内展开），因此本脚本里没有账号密码，
#     也不会出现在宿主机的进程列表里。
#
# 排序是**约定的一部分**，不是优化：
#   - `source` 按 `_id` 升序、`translation` 按 `{o:1,t:1}` 升序 ——
#     迁移工具靠这两个顺序做归并，顺序不对会直接报错退出（宁可不跑，也不要错配）。
#
set -euo pipefail

OUT="${1:-}"
if [ -z "$OUT" ]; then
  echo "用法：$0 <输出目录> [mongo 容器名]" >&2
  exit 1
fi

CONTAINER="${2:-}"
if [ -z "$CONTAINER" ]; then
  # 默认去认名字里带 mongodb 的容器（旧站的 compose 项目名不固定，所以不写死）
  CONTAINER="$(docker ps --format '{{.Names}}' | grep -i mongodb | head -1 || true)"
fi
if [ -z "$CONTAINER" ]; then
  echo "[错误] 找不到 mongo 容器，请把容器名作为第二个参数传进来。" >&2
  exit 1
fi

DB_NAME="${MOEFLOW_DB:-moeflow}"

# 集合清单 = 旧站会写进库的全部集合（含明确不迁的，它们也要在报告里出现去向）
COLLECTIONS=(
  user team team_role team_user_relation
  project_set project project_role project_user_relation
  target language file source translation
  notice user_notice_read invitation_code
  file_target_cache output celery_taskmeta v_code
  action_log error_log media_import_task
  tip term_bank term_group term
  invitation application message site_setting
)

# 建议：迁移前先在只读副本上跑一遍，确认耗时与体积
mkdir -p "$OUT"

# 在容器内展开凭据：宿主机的命令行里因此看不到密码
mongo_shell() {
  docker exec -i "$CONTAINER" sh -c \
    "mongo $DB_NAME --quiet -u \"\$MONGO_INITDB_ROOT_USERNAME\" -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin"
}

export_collection() {
  local name="$1"
  local sort=""
  case "$name" in
    source) sort='--sort={_id:1}' ;;
    translation) sort='--sort={o:1,t:1}' ;;
  esac
  if docker exec -i "$CONTAINER" sh -c \
      "mongoexport --db $DB_NAME -u \"\$MONGO_INITDB_ROOT_USERNAME\" -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin --collection $name $sort --jsonFormat=relaxed" \
      > "$OUT/$name.json" 2>"$OUT/$name.err"; then
    printf '  %-24s %s 行\n' "$name" "$(wc -l < "$OUT/$name.json" | tr -d ' ')"
    rm -f "$OUT/$name.err"
  else
    # 空集合会让 mongoexport 直接报错，这是正常的：留一个空文件，计数由 manifest 兜底
    printf '  %-24s （不存在或为空）\n' "$name"
    : > "$OUT/$name.json"
    rm -f "$OUT/$name.err"
  fi
}

echo "[1/2] 导出集合 → $OUT"
for c in "${COLLECTIONS[@]}"; do
  export_collection "$c"
done

# manifest 记的是**导出那一刻库里的文档数**，迁移工具拿它跟文件行数逐一比 ——
# 少导一截的 snapshot 看起来也是一份合法输入，只有这个对账拦得住。
echo "[2/2] 写 manifest.json"
COLLECTION_LIST="$(printf '"%s",' "${COLLECTIONS[@]}")"
COLLECTION_LIST="[${COLLECTION_LIST%,}]"
{
  printf 'const names = %s;\n' "$COLLECTION_LIST"
  cat <<'JS'
const out = {};
names.forEach((n) => { out[n] = db.getCollection(n).countDocuments({}); });
print(JSON.stringify({ exportedAt: new Date().toISOString(), collections: out }));
JS
# 直接写一行 JSON：读取端只做 JSON.parse，不依赖缩进，也就不需要额外的解释器
} | mongo_shell | tail -1 > "$OUT/manifest.json"

DOCS="$(grep -o ':[0-9]\+' "$OUT/manifest.json" | tr -d ':' | paste -sd+ - | bc 2>/dev/null || echo '?')"
echo "  manifest.json 写好（共 ${DOCS} 个文档）"

echo "完成。下一步："
echo "  盘点  node backend/dist/cli/migrate-moeflow.js inventory --export $OUT"
echo "  迁移  node backend/dist/cli/migrate-moeflow.js migrate   --export $OUT --images-dir <旧存储挂载目录>"
