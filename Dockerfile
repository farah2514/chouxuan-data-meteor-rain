FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY sampler/requirements.txt ./sampler/requirements.txt
RUN pip3 install --no-cache-dir -r ./sampler/requirements.txt

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV ALLOW_ASSISTED_EXTRACT=false

EXPOSE 3000

CMD ["npm", "start"]
