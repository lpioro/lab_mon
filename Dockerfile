FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.source="https://github.com/lpioro/lab_mon" \
      org.opencontainers.image.description="Read-only Proxmox inventory dashboard"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LAB_MON_CONFIG=/config/config.toml
ENV LAB_MON_HISTORY_DB=/data/history.sqlite3
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && install -d -m 0700 -o 10001 -g 10001 /data
COPY lab_mon/ ./lab_mon/
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python", "-m", "lab_mon", "--host", "0.0.0.0"]
