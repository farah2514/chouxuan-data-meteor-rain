FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY sampler/requirements.txt ./sampler/requirements.txt
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir -r ./sampler/requirements.txt

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV ALLOW_ASSISTED_EXTRACT=false
ENV PATH="/opt/venv/bin:${PATH}"

EXPOSE 3000

CMD ["npm", "start"]
