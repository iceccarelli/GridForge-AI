# The engine as a service. No dependencies, so the image is the interpreter plus
# ~4k lines of Python; it starts in milliseconds and has nothing to patch.
FROM python:3.13-slim

WORKDIR /app
COPY gridforge/ ./gridforge/
COPY examples/intake/ ./examples/intake/
COPY pyproject.toml ./

ENV PYTHONUNBUFFERED=1 \
    GRIDFORGE_RATE_LIMIT=30

EXPOSE 8080
# Paid endpoints stay disabled until GRIDFORGE_API_KEYS is set: a misconfigured
# deployment must fail closed, not serve the deliverable for free.
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=2).status==200 else 1)"

CMD ["python", "-m", "gridforge", "serve", "--host", "0.0.0.0", "--port", "8080"]
