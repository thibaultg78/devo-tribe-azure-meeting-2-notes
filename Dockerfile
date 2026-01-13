FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY styles.css ./
COPY prompts.js ./
COPY config*.js ./

EXPOSE 8080

CMD ["node", "server.js"]