# 构建上下文是仓库根目录：
#   docker build -f frontend/Dockerfile -t 405nm-frontend:dev .
#
# ⚠️ 本镜像**不含构建步骤**，需要先在本地跑 `npm run build:frontend` 产出 frontend/build/。
#
# 为什么这样可以：Vite 的产物是纯静态文件（JS/CSS/HTML），与平台无关，
# 在 Windows 上构建再上传完全没有问题 —— 这正是彩翻/380nm 现用的流程，
# 也避开了远程机器内存不足构建 OOM 的问题。
#
# 反过来，**后端不能这么干**：它要调 Debian 的 libvips 命令行（见 backend/Dockerfile），
# 而且 Windows 上装好的 node_modules 传过去必崩。

FROM nginx:1.26

COPY ./frontend/build /usr/share/nginx/html
COPY ./deploy/nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
