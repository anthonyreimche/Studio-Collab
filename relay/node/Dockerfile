# Studio Collab relay: Node 22, no packages.
#   docker build -t studio-collab-relay -f relay/node/Dockerfile .
#   docker run -d -p 8787:8787 -v studio-collab-data:/data studio-collab-relay
FROM node:22-alpine
WORKDIR /relay
COPY relay/shared ./shared
COPY relay/node ./node
ENV PORT=8787 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "node/server.mjs"]
