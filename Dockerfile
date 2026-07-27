FROM python:3.12-slim

WORKDIR /app

# Зависимости отдельным слоем — быстрее пересборка
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Веб-сервер Mini App слушает этот порт (PaaS обычно пробрасывает свой через $PORT)
EXPOSE 8080

CMD ["python", "-m", "bot.main"]
