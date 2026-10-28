FROM python:3.13-slim
WORKDIR /app
COPY api/requirements.txt api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt
COPY contracts contracts
COPY api api
WORKDIR /app/api
RUN useradd --create-home --uid 10001 screenforge && mkdir -p /app/api/data && chown screenforge /app/api/data
USER screenforge
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
