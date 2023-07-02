FROM python:3.8-slim

RUN apt-get update && apt-get install -y git

RUN git clone https://github.com/edmundhong/formula1-dataanalysis.git /formula1-dataanalysis

WORKDIR /formula1-dataanalysis

RUN pip install -r requirements1.txt
