FROM python:3.13-slim
WORKDIR /app
COPY plant_sim/requirements.txt plant_sim/requirements.txt
RUN pip install --no-cache-dir -r plant_sim/requirements.txt
COPY contracts contracts
COPY plant_sim plant_sim
RUN useradd --create-home --uid 10002 plant
USER plant
EXPOSE 4840 5020 5021 8090
CMD ["python", "-m", "plant_sim"]
