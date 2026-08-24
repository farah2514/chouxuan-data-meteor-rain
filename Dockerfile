FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

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
