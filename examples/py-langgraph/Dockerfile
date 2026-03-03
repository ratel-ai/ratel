FROM python:3.12-slim

WORKDIR /app

COPY src/py-packages/sdk /app/sdk
RUN pip install --no-cache-dir /app/sdk

COPY examples/py-langgraph /app/agent
RUN pip install --no-cache-dir /app/agent

CMD ["python", "-m", "quickhr.main"]
