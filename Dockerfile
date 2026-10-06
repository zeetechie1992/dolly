# Dolly: recorder + editor + share links in one small Python server.
#   docker build -t dolly .
#   docker run -p 127.0.0.1:8000:8000 -v dolly-data:/data \
#     -e DOLLY_PUBLIC_URL=https://dolly.example.com -e DOLLY_SHARE_KEY=paste-a-long-random-secret-here dolly
#   (generate the key once with: openssl rand -hex 24; Dolly ignores keys under 16 characters)
# Put it behind HTTPS (Caddy, or your host's TLS): browsers only allow screen recording
# on https:// or localhost. See README "Sharing publicly".
FROM python:3.12-slim

WORKDIR /app

COPY . .

ENV DOLLY_HOST=0.0.0.0 \
    DOLLY_DATA_DIR=/data \
    PORT=8000 \
    PYTHONUNBUFFERED=1

# Mount persistent storage at /data (docker run -v dolly-data:/data, or your host's volume
# setting). No VOLUME instruction: some hosts, including Railway, reject it.
EXPOSE 8000

CMD ["python", "server.py"]
