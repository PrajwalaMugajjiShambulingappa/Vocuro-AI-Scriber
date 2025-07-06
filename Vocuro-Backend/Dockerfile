# Use lightweight Python image
FROM python:3.10-slim

# System dependencies (FFmpeg for audio conversion)
RUN apt-get update && apt-get install -y \
    ffmpeg git && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy backend files into container
COPY . .

# Install Python dependencies
RUN pip install --upgrade pip
RUN pip install -r requirements.txt

# Preload Whisper model to cache it inside the container (optional)
RUN python -c "import whisper; whisper.load_model('small')"

# Expose port
EXPOSE 5001

# Run the backend
CMD ["python", "speech_to_text.py"]
