FROM node:22.9.0-alpine3.20

RUN mkdir -p /opt/service

WORKDIR /opt/service

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json tsconfig.test.json eslint.config.js ./
COPY src src
