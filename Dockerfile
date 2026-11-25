# Stage 1: build the Python environment (compilers and git are needed only here).
FROM python:3.11-slim-trixie AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      git \
      libfftw3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.11.0 torchaudio==2.11.0 \
    && pip install --no-cache-dir -r /tmp/requirements.txt

# Stage 2: the app, with only what it needs at run time.
FROM python:3.11-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    HITMAPPER_DATA_DIR=/data \
    HITMAPPER_DEVICE=cpu \
    HOME=/data/home \
    HF_HOME=/data/models/huggingface \
    TORCH_HOME=/data/models/torch \
    XDG_CACHE_HOME=/data/cache \
    PORT=8766

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libgomp1 \
      libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown 10001:10001 /data

COPY --from=build /opt/venv /opt/venv

WORKDIR /app
COPY --chown=10001:10001 server.py analysis_pipeline.py index.html app.js styles.css ./
USER 10001:10001

VOLUME ["/data"]
EXPOSE 8766

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8766/api/status', timeout=3)" || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:8766", "--workers", "1", "--threads", "4", "--timeout", "0", "server:app"]
