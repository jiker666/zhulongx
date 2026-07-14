FROM python:3.11-slim
RUN useradd --create-home --uid 10001 worker
WORKDIR /opt/worker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN mkdir -p /workspace/tasks && chown -R worker:worker /opt/worker /workspace/tasks
USER worker
EXPOSE 8090
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
