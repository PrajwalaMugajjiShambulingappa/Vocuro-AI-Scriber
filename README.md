# Vocuro
Vocuro is a lightweight and powerful AI-powered tool that converts speech to text, generates accurate transcripts, and summarizes conversations intelligently. Perfect for meetings, lectures, interviews, podcasts, and more.

## Features
- 🎙️ Speech-to-Text: Converts audio into high-quality text using automatic speech recognition (ASR).
- 📄 Transcript Generation: Outputs a full, time-aligned transcript of the conversation.
- 🧠 Conversation Summarization: Uses advanced language models to summarize the key points of any discussion.

## Setup
### Create a virtual environment: 
- python -m venv venv

### Activate the Virtual Environment: 
- source venv/bin/activate (for MAC) 
- .\venv\Scripts\activate (for Windows)

## Install ffmpeg
- brew install ffmpeg (MacOS)
- Download ffmpeg from: https://ffmpeg.org/download.html and Add ffmpeg/bin to your system PATH.

## Run the frontend: 
- cd Vocuro-UI
- npm install
- npm run dev

## Run the backend: 
- docker build -t vocuro-backend ./Vocuro-Backend
- docker run -p 5001:5001 \
  -v "$(pwd)/Vocuro-Backend/transcripts:/app/transcripts" \
  vocuro-backend


## Open your browser at:
- http://localhost:5173

