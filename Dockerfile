# 服务器模式的容器。用法：
#   docker build -t cyber-favorites .
#   docker run -d -p 127.0.0.1:4170:4170 -v cf-data:/data -e CF_PUBLIC_URL=https://fav.example.com cyber-favorites
#   docker logs <容器>   ← 第一次启动时这里会打印登录链接
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json LICENSE ./
COPY lib ./lib
COPY public ./public
COPY skill ./skill
RUN mkdir -p /data && chown node:node /data
USER node
# 容器里要监听所有网卡，端口映射才能进来；CF_HOST=0.0.0.0 只在服务器模式下允许
ENV CF_HOST=0.0.0.0 CF_PORT=4170 CF_DATA=/data/data.json
VOLUME /data
EXPOSE 4170
CMD ["node", "server.js"]
