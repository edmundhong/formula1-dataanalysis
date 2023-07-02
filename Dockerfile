FROM python:3.9

# Install git
RUN apt-get update && apt-get install -y git

# Clone the repository
RUN git clone https://github.com/edmundhong/formula1-dataanalysis.git

WORKDIR /formula1-dataanalysis

COPY requirements1.txt /requirements1.txt

RUN python3 -m pip install -r /requirements1.txt

EXPOSE 8888

# Start Jupyter notebook when the container launches
CMD ["jupyter", "notebook", "--ip=0.0.0.0", "--port=8888", "--no-browser", "--allow-root"]