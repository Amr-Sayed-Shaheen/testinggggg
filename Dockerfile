FROM node:20-alpine

WORKDIR /app

# install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# copy project files
COPY . .

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "src/server.js"]
