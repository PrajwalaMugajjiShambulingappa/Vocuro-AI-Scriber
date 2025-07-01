from flask import Flask, request, jsonify
from flask_cors import CORS
import whisper
import tempfile
import os

app = Flask(__name__)
CORS(app) 
model = whisper.load_model("small")  # or "small", "medium", etc.

@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    if audio_file.filename == '':
        return jsonify({"error": "Empty filename"}), 400

    with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as temp_audio:
        audio_file.save(temp_audio.name)
        print(f"Saved temp file: {temp_audio.name}")
        try:
            result = model.transcribe(temp_audio.name)
            print(f"Transcription result: {result['text']}")
            return jsonify({"text": result['text']})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            os.remove(temp_audio.name)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True)
