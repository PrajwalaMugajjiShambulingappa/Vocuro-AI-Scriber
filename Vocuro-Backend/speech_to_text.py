from flask import Flask, request, jsonify
from flask_cors import CORS
import whisper
import tempfile
import os
import logging
from pathlib import Path
import threading
import time

app = Flask(__name__)
CORS(app)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load Whisper model once
print("Loading Whisper model...")
model = whisper.load_model("small")
print("Whisper model loaded successfully")

# Folder and file paths
SESSION_ID_FILE = "session_counter.txt"
ACTIVE_SESSION_FILE = "active_session.txt"
SESSION_FOLDER = "transcripts"
os.makedirs(SESSION_FOLDER, exist_ok=True)

# Global character count tracking and session management
char_count = {}
active_sessions = {}  # Track active sessions with timestamps
session_lock = threading.Lock()  # Prevent race conditions

# --- Improved Session Helpers --- #
def get_next_session_id():
    """Get and increment session counter from file."""
    if not os.path.exists(SESSION_ID_FILE):
        with open(SESSION_ID_FILE, 'w') as f:
            f.write("1")
        return 1
    
    try:
        with open(SESSION_ID_FILE, 'r') as f:
            session_id = int(f.read().strip())
        return session_id
    except (ValueError, FileNotFoundError):
        return 1

def increment_session_id():
    current_id = get_next_session_id()
    with open(SESSION_ID_FILE, 'w') as f:
        f.write(str(current_id + 1))

def set_active_session_id(session_id):
    with session_lock:
        with open(ACTIVE_SESSION_FILE, 'w') as f:
            f.write(str(session_id))
        # Track session with timestamp
        active_sessions[session_id] = {
            'created': time.time(),
            'last_activity': time.time()
        }

def get_active_session_id():
    if not os.path.exists(ACTIVE_SESSION_FILE):
        return None
    try:
        with open(ACTIVE_SESSION_FILE, 'r') as f:
            session_id = int(f.read().strip())
        
        # Update last activity if session exists
        with session_lock:
            if session_id in active_sessions:
                active_sessions[session_id]['last_activity'] = time.time()
        
        return session_id
    except (ValueError, FileNotFoundError):
        return None

def validate_audio_file(file_path):
    """Enhanced audio file validation."""
    if not os.path.exists(file_path):
        return False, "File does not exist"
    
    file_size = os.path.getsize(file_path)
    if file_size < 500:  # Less than 500 bytes
        return False, f"File too small: {file_size} bytes"
    
    if file_size > 100 * 1024 * 1024:  # Larger than 100MB
        return False, f"File too large: {file_size} bytes"
    
    # Check if file has some basic structure
    try:
        with open(file_path, 'rb') as f:
            header = f.read(12)
            # Check for WebM/Matroska magic bytes
            if len(header) >= 4:
                if header[:4] == b'\x1a\x45\xdf\xa3':  # EBML header
                    return True, "Valid WebM/Matroska"
                elif header[4:8] == b'ftyp':  # MP4 header
                    return True, "Valid MP4"
                elif header[:4] == b'RIFF':  # WAV header
                    return True, "Valid WAV"
                else:
                    logger.warning(f"Unknown file format, header: {header.hex()}")
                    return True, "Unknown format but proceeding"
            else:
                return False, "Invalid file header"
    except Exception as e:
        logger.error(f"Error reading file header: {e}")
        return False, f"Cannot read file: {e}"

def cleanup_old_sessions():
    """Clean up sessions older than 1 hour."""
    current_time = time.time()
    expired_sessions = []
    
    with session_lock:
        for session_id, info in active_sessions.items():
            if current_time - info['last_activity'] > 3600:  # 1 hour
                expired_sessions.append(session_id)
        
        for session_id in expired_sessions:
            del active_sessions[session_id]
            logger.info(f"🧹 Cleaned up expired session {session_id}")

def transcribe_with_fallback(temp_audio_path):
    """
    Enhanced transcription with multiple fallback strategies for WebM issues
    Returns the result dictionary directly, not a tuple
    """
    try:
        # First attempt: Direct transcription
        result = model.transcribe(
            temp_audio_path,
            fp16=False,
            verbose=False,
            word_timestamps=False,
            language=None,
            task="transcribe"
        )
        logger.info("Primary transcription succeeded")
        return result  # Return result directly, not tuple
        
    except Exception as primary_error:
        logger.warning(f"Primary transcription failed: {primary_error}")
        
        # Fallback 1: Try converting to WAV first
        try:
            import subprocess
            wav_path = temp_audio_path.replace('.webm', '_converted.wav')
            
            # Use ffmpeg to convert to WAV
            subprocess.run([
                'ffmpeg', '-i', temp_audio_path, 
                '-ar', '16000',  # 16kHz sample rate
                '-ac', '1',      # Mono
                '-y',            # Overwrite output
                wav_path
            ], check=True, capture_output=True)
            
            # Try transcribing the converted file
            result = model.transcribe(wav_path, fp16=False, verbose=False)
            
            # Clean up converted file
            if os.path.exists(wav_path):
                os.remove(wav_path)
                
            logger.info("Successfully transcribed after WAV conversion")
            return result  # Return result directly
            
        except Exception as fallback_error:
            logger.warning(f"WAV conversion fallback failed: {fallback_error}")
            
        # Fallback 2: Try with different ffmpeg options
        try:
            # More lenient ffmpeg options
            result = model.transcribe(
                temp_audio_path,
                fp16=False,
                verbose=False,
                word_timestamps=False,
                language=None,
                task="transcribe",
                # Add these parameters for more robust handling
                condition_on_previous_text=False,
                temperature=0.0,
                compression_ratio_threshold=2.4,
                logprob_threshold=-1.0,
                no_speech_threshold=0.6
            )
            logger.info("Successfully transcribed with lenient options")
            return result  # Return result directly
            
        except Exception as final_error:
            logger.error(f"All transcription attempts failed: {final_error}")
            raise final_error

# --- Routes --- #
@app.route('/health', methods=['GET'])
def health_check():
    """Enhanced health check endpoint."""
    cleanup_old_sessions()
    return jsonify({
        "status": "healthy",
        "whisper_model": "small",
        "active_session": get_active_session_id(),
        "total_sessions": len(active_sessions),
        "server_time": time.time()
    })

@app.route('/start_session', methods=['POST'])
def start_session():
    try:
        # Check if there's already an active session less than 30 seconds old
        current_session = get_active_session_id()
        if current_session and current_session in active_sessions:
            session_age = time.time() - active_sessions[current_session]['created']
            if session_age < 30:  # Less than 30 seconds old
                logger.info(f"♻️ Reusing recent session {current_session} (age: {session_age:.1f}s)")
                return jsonify({
                    "session_id": current_session,
                    "session_key": f"{current_session:03d}",
                    "status": "reused",
                    "age": session_age
                })
        
        # Create new session
        session_id = get_next_session_id()
        increment_session_id()
        session_key = f"{session_id:03d}"
        char_count[session_key] = 0
        set_active_session_id(session_id)
        
        logger.info(f"Started NEW session {session_key}")
        print(f"--- Started session {session_key} ---")
        
        return jsonify({
            "session_id": session_id,
            "session_key": session_key,
            "status": "new"
        })
    except Exception as e:
        logger.error(f"Error starting session: {str(e)}")
        return jsonify({"error": f"Failed to start session: {str(e)}"}), 500

@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    session_id = get_active_session_id()
    if session_id is None:
        return jsonify({"error": "No active session. Start a session first."}), 400

    session_key = f"{session_id:03d}"
    filename = f"{SESSION_FOLDER}/SessionID-{session_key}.txt"

    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    if audio_file.filename == '':
        return jsonify({"error": "Empty filename"}), 400

    # Determine file extension based on content type
    file_ext = '.webm'
    content_type = audio_file.content_type or ''
    if 'mp4' in content_type:
        file_ext = '.mp4'
    elif 'wav' in content_type:
        file_ext = '.wav'
    elif 'mpeg' in content_type or 'mp3' in content_type:
        file_ext = '.mp3'

    temp_audio_path = None
    try:
        # Save uploaded file
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as temp_audio:
            temp_audio_path = temp_audio.name
            audio_file.save(temp_audio_path)
            
        file_size = os.path.getsize(temp_audio_path)
        logger.info(f"Saved temp file: {temp_audio_path} ({file_size:,} bytes, type: {content_type})")

        # Enhanced validation
        is_valid, validation_msg = validate_audio_file(temp_audio_path)
        if not is_valid:
            logger.warning(f"Invalid audio file: {validation_msg}")
            return jsonify({
                "error": f"Invalid audio file: {validation_msg}",
                "file_size": file_size,
                "content_type": content_type
            }), 422

        # Attempt transcription with enhanced error handling
        try:
            logger.info("Starting transcription...")
            
            # FIXED: Now properly handles the result dictionary
            result = transcribe_with_fallback(temp_audio_path)
            
            text = result.get('text', '').strip()
            detected_language = result.get('language', 'unknown')
            # Note: language_probability might not always be available
            confidence = getattr(result, 'language_probability', 0.0) if hasattr(result, 'language_probability') else 0.0

            logger.info(f"Transcription result: '{text}' (lang: {detected_language}, conf: {confidence:.2f})")

            if text:
                # Save to session file
                with open(filename, "a", encoding='utf-8') as f:
                    f.write(text + "\n")

                # Track characters and detect milestone
                char_count.setdefault(session_key, 0)
                prev_count = char_count[session_key]
                char_count[session_key] += len(text)

                milestone_hit = char_count[session_key] // 5000 > prev_count // 5000
                if milestone_hit:
                    logger.info(f"[{session_key}] Hit {char_count[session_key]:,} characters milestone")

                return jsonify({
                    "text": text,
                    "milestone": milestone_hit,
                    "char_count": char_count[session_key],
                    "language": detected_language,
                    "confidence": confidence,
                    "file_size": file_size
                })
            else:
                logger.info("No speech detected in audio")
                return jsonify({
                    "text": "", 
                    "message": "No speech detected",
                    "language": detected_language,
                    "file_size": file_size
                })

        except Exception as whisper_error:
            error_msg = str(whisper_error)
            logger.error(f"Whisper transcription error: {error_msg}")
            
            # Enhanced error classification
            if "EBML header parsing failed" in error_msg:
                return jsonify({
                    "error": "Corrupted WebM file. Try refreshing and recording again.",
                    "error_type": "webm_corruption",
                    "file_size": file_size
                }), 422
            elif "ffmpeg" in error_msg.lower():
                return jsonify({
                    "error": "Audio format not supported. Try using a different browser.",
                    "error_type": "format_unsupported",
                    "file_size": file_size
                }), 422
            elif "load audio" in error_msg.lower():
                return jsonify({
                    "error": "Failed to load audio file. Recording may be incomplete.",
                    "error_type": "audio_load_failed",
                    "file_size": file_size
                }), 422
            else:
                return jsonify({
                    "error": f"Transcription failed: {error_msg}",
                    "error_type": "transcription_failed",
                    "file_size": file_size
                }), 500

    except Exception as e:
        logger.error(f"Unexpected error in transcribe_audio: {str(e)}")
        return jsonify({"error": f"Server error: {str(e)}"}), 500
    
    finally:
        # Clean up temp file
        if temp_audio_path and os.path.exists(temp_audio_path):
            try:
                os.remove(temp_audio_path)
                logger.info(f"Cleaned up temp file: {temp_audio_path}")
            except Exception as cleanup_error:
                logger.warning(f"Failed to cleanup temp file: {cleanup_error}")

# --- Main --- #
if __name__ == '__main__':
    print("Starting speech-to-text server...")
    print("Server will be available at:")
    print("- http://localhost:5001")
    print("- http://127.0.0.1:5001")
    print("Whisper model: small")
    print("Transcripts folder:", SESSION_FOLDER)
    
    app.run(host='0.0.0.0', port=5001, debug=True)