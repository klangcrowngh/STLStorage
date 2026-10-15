FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    STL_DATA_DIR=/data \
    STL_PORT=8000

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY static ./static

VOLUME ["/data"]
EXPOSE 8000
CMD ["python", "app.py"]
