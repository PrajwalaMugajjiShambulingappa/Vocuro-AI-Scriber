import React, { useState, useRef } from 'react';

const MicRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const handleMicClick = async () => {
    if (!isRecording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          audioChunksRef.current.push(event.data);
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const formData = new FormData();
          formData.append('audio', audioBlob, 'recording.webm');

          try {
            const response = await fetch('http://localhost:5001/transcribe', {
              method: 'POST',
              body: formData,
            });

            const result = await response.json();
            if (result.text) {
              setTranscript(result.text);
            } else {
              setTranscript('Error: ' + (result.error || 'Unknown error'));
            }
          } catch (err) {
            console.error('Error sending audio:', err);
            setTranscript('Failed to reach backend.');
          }
        };

        mediaRecorder.start();
        setIsRecording(true);
      } catch (err) {
        console.error('Mic access error:', err);
        setTranscript('Microphone access denied.');
      }
    } else {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.inner}>
        <button onClick={handleMicClick} style={styles.micButton}>
            <img src="public/mic.png" alt="Mic Icon" style={styles.micImage} />
        </button>
        <p style={styles.transcript}>{transcript}</p>
      </div>
    </div>
  );
};

const styles = {
  container: {
    backgroundColor: 'black',
    height: '100vh',
    width: '100vw',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    textAlign: 'center',
  },
  inner: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '20px',
  },
  micButton: {
    backgroundColor: '#fff',
    height: '300px',
    width: '350px'
  },
  micImage: {
    height: '300px',
    width: '300px'
  },
  transcript: {
    maxWidth: '80%',
    fontSize: '1.2rem',
    marginTop: '10px',
    color: '#00ffcc',
  },
};

export default MicRecorder;
