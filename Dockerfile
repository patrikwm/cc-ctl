FROM node:24-slim
WORKDIR /app
COPY package.json server.mjs hook.mjs query.mjs ui.html ./
COPY lib ./lib
# /data holds the SQLite history; world-writable so any --user uid can use a fresh named volume.
RUN mkdir /data && chmod 1777 /data
ENV HOST=0.0.0.0 CC_CTL_PORT=8080 CLAUDE_CONFIG_DIR=/claude CC_CTL_DB=/data/history.db NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/api/help').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
