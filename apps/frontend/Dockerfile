# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app

RUN npm install -g pnpm@10
COPY package.json ./
RUN pnpm install

COPY . .
RUN pnpm build

FROM nginxinc/nginx-unprivileged:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
