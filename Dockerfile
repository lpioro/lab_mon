FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.source="https://github.com/lpioro/lab_mon" \
      org.opencontainers.image.description="Read-only Proxmox inventory dashboard"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LAB_MON_CONFIG=/config/config.toml
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY lab_mon/ ./lab_mon/
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python", "-m", "lab_mon", "--host", "0.0.0.0"]
