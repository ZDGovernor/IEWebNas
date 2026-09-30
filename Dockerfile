# IE 网盘 —— 纯 Node 官方镜像，无第三方依赖，无需 npm install
FROM node:20-alpine

LABEL maintainer="ie-webdisk" \
      description="兼容 IE8+ 的在线文件上传下载站"

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# 仅拷贝运行所需文件（没有依赖，不需要 npm install）
COPY package.json ./
COPY config.js server.js ./
COPY lib ./lib
COPY public ./public

# 数据目录：上传文件与元数据都放这里，务必挂载卷
RUN mkdir -p /data/uploads /data/tmp && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)})"

CMD ["node", "server.js"]