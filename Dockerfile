FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY shipstation-shopify-rates-server.js ./
COPY README.shipstation-carrier.md ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
