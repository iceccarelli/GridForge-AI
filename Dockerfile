# The engine as a service. No dependencies, so the image is the interpreter plus
# ~4k lines of Python; it starts in milliseconds and has nothing to patch.
FROM python:3.13-slim

# The engine never needs root. It runs as `gridforge` (uid 10001). Everything it writes lives under /data (usage meter,
# revocation list, usage ledger, cost file: see fly.toml), and nothing is written under /app.
RUN groupadd --gid 10001 gridforge \
 && useradd --uid 10001 --gid gridforge --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin gridforge \
 && mkdir -p /data \
 && chown gridforge:gridforge /data

WORKDIR /app
COPY gridforge/ ./gridforge/
COPY examples/intake/ ./examples/intake/
COPY pyproject.toml ./

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    GRIDFORGE_RATE_LIMIT=30

EXPOSE 8080
# Paid endpoints stay disabled until GRIDFORGE_API_KEYS is set: a misconfigured
# deployment must fail closed, not serve the deliverable for free.
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=2).status==200 else 1)"

# A freshly created Fly volume is mounted root-owned, over the /data the image prepared, so a process that was never root
# could not write its ledger there and every metered key would be refused with a 503. So the container STARTS as root only
# long enough to hand /data to `gridforge`, then permanently drops to it (setpriv: real+effective uid/gid and supplementary
# groups, no way back) BEFORE python starts: the engine itself never runs as root. A platform that already starts the
# container as a non-root user (Kubernetes runAsUser, `docker run --user`) skips the chown and runs as that user; /data
# must then be writable by it.
CMD ["sh", "-c", "if [ \"$(id -u)\" = 0 ]; then chown -R gridforge:gridforge /data 2>/dev/null; exec setpriv --reuid=gridforge --regid=gridforge --init-groups python -m gridforge serve --host 0.0.0.0 --port 8080; fi; exec python -m gridforge serve --host 0.0.0.0 --port 8080"]
