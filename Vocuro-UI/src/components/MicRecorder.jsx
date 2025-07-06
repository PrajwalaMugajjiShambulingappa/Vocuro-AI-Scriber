import React, { useState, useRef, useEffect } from 'react';

const MicRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [currentSession, setCurrentSession] = useState(null);
  
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunkQueue = useRef([]);
  const isProcessing = useRef(false);
  const sessionStarting = useRef(false);
  const chunkCounter = useRef(0);
  const audioChunks = useRef([]);

  useEffect(() => {
    testConnection();
  }, []);

  const testConnection = async () => {
    try {
      const response = await fetch('http://localhost:5001/health');
      if (response.ok) {
        setIsConnected(true);
        console.log('Backend connected');
      }
    } catch (err) {
      console.error('Backend connection failed:', err);
      setIsConnected(false);
    }
  };

  const sendChunkToBackend = async (audioBlob) => {
    if (isProcessing.current) return;
    isProcessing.current = true;

    const chunkNum = ++chunkCounter.current;
    console.log(`Sending chunk #${chunkNum}: ${audioBlob.size} bytes`);

    const formData = new FormData();
    formData.append('audio', audioBlob, `chunk-${chunkNum}.webm`);

    try {
      const response = await fetch('http://localhost:5001/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`HTTP ${response.status}: ${errorData.error || response.statusText}`);
      }

      const result = await response.json();
      
      if (result.text && result.text.trim()) {
        const newText = result.text.trim();
        console.log(`Chunk #${chunkNum} transcribed: "${newText}"`);
        setTranscript(prev => prev ? prev + ' ' + newText : newText);
        
        if (result.milestone) {
          console.log("Reached 5000 character milestone");
        }
      } else {
        console.log(`Chunk #${chunkNum}: No speech detected`);
      }
    } catch (err) {
      console.error(`Error sending chunk #${chunkNum}:`, err);
    } finally {
      isProcessing.current = false;
      
      setTimeout(() => {
        if (chunkQueue.current.length > 0 && !isProcessing.current) {
          const nextChunk = chunkQueue.current.shift();
          sendChunkToBackend(nextChunk);
        }
      }, 100);
    }
  };

  // NEW: Function to create complete audio file from accumulated chunks
  const createCompleteAudioFile = () => {
    if (audioChunks.current.length === 0) return null;
    
    // Combine all chunks into one complete file
    const completeBlob = new Blob(audioChunks.current, { 
      type: 'audio/webm;codecs=opus' 
    });
    
    console.log(`Created complete audio file: ${completeBlob.size} bytes from ${audioChunks.current.length} chunks`);
    return completeBlob;
  };

  const startNewSession = async () => {
    if (sessionStarting.current) {
      console.log('ession already starting, skipping duplicate');
      return currentSession;
    }
    
    sessionStarting.current = true;
    
    try {
      const response = await fetch('http://localhost:5001/start_session', {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to start session: ${response.status}`);
      }
      
      const data = await response.json();
      console.log("🎬 Started session:", data.session_id);
      setCurrentSession(data.session_id);
      setTranscript('');
      chunkCounter.current = 0;
      audioChunks.current = []; 
      return data.session_id;
    } catch (err) {
      console.error('Failed to start session:', err);
      return null;
    } finally {
      sessionStarting.current = false;
    }
  };

  const handleMicClick = async () => {
    if (!isConnected) {
      console.log('Backend not connected, trying to reconnect...');
      await testConnection();
      if (!isConnected) {
        setTranscript('Cannot connect to backend server');
        return;
      }
    }

    if (!isRecording) {
      // Start recording
      if (!currentSession && !sessionStarting.current) {
        const sessionId = await startNewSession();
        if (!sessionId) {
          setTranscript('Failed to start recording session');
          return;
        }
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 44100,
            channelCount: 1
          } 
        });
        
        streamRef.current = stream;

        const mimeTypes = [
          'audio/webm;codecs=opus',
          'audio/mp4;codecs=mp4a.40.2',
          'audio/wav',
          'audio/webm',
          'audio/mp4'
        ];

        let selectedMimeType = '';
        for (const mimeType of mimeTypes) {
          if (!mimeType || MediaRecorder.isTypeSupported(mimeType)) {
            selectedMimeType = mimeType;
            break;
          }
        }

        console.log(`Using MIME type: ${selectedMimeType || 'browser default'}`);

        const options = selectedMimeType ? { mimeType: selectedMimeType } : {};
        const mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = mediaRecorder;

        let chunkIndex = 0;
        mediaRecorder.ondataavailable = (event) => {
          chunkIndex++;
          console.log(`Chunk #${chunkIndex} received: ${event.data.size} bytes, type: ${event.data.type}`);
          
          if (event.data && event.data.size > 1000) {
            // Store chunk for complete file creation
            audioChunks.current.push(event.data);
            
            const completeFile = createCompleteAudioFile();
            if (completeFile) {
              chunkQueue.current.push(completeFile);
              
              if (!isProcessing.current) {
                const chunk = chunkQueue.current.shift();
                sendChunkToBackend(chunk);
              }
            }
          } else {
            console.log(`Skipping small/empty chunk #${chunkIndex}: ${event.data.size} bytes`);
          }
        };

        mediaRecorder.onerror = (event) => {
          console.error('MediaRecorder error:', event.error);
          setTranscript('Recording error occurred');
        };

        mediaRecorder.onstart = () => {
          console.log('Recording started');
          setTranscript('Listening...');
          audioChunks.current = []; // Clear previous chunks
        };

        mediaRecorder.onstop = () => {
          console.log('Recording stopped');
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
          }
          
          // Send final complete file
          const finalFile = createCompleteAudioFile();
          if (finalFile && finalFile.size > 1000) {
            console.log('Sending final complete audio file');
            sendChunkToBackend(finalFile);
          }
        };

        // SOLUTION 3: Use longer intervals and stop/restart for clean chunks
        mediaRecorder.start(5000); // 5-second chunks
        setIsRecording(true);

      } catch (err) {
        console.error('Mic access error:', err);
        setTranscript('Microphone access denied or not available');
      }
    } else {
      // Stop recording
      console.log('Stopping recording...');
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      
      setTimeout(() => {
        setCurrentSession(null);
      }, 1000);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.inner}>
        {/* Connection status */}
        <div style={{
          ...styles.status,
          backgroundColor: isConnected ? '#28a745' : '#dc3545'
        }}>
          {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
        </div>

        {/* Session info */}
        {currentSession && (
          <div style={styles.sessionInfo}>
            📋 Session: {currentSession} | Chunks: {chunkCounter.current} | Stored: {audioChunks.current.length}
          </div>
        )}

        {/* Mic button */}
        <button 
          onClick={handleMicClick} 
          style={{
            ...styles.micButton,
            backgroundColor: isRecording ? '#ff4444' : '#ffffff',
            transform: isRecording ? 'scale(1.1)' : 'scale(1)',
            boxShadow: isRecording ? '0 0 20px rgba(255, 68, 68, 0.5)' : 'none'
          }}
          disabled={!isConnected || sessionStarting.current}
        >
          <div style={styles.micIcon}>
            {sessionStarting.current ? '⏳' : (isRecording ? '⏹️' : '🎤')}
          </div>
        </button>

        {/* Status text */}
        <p style={styles.statusText}>
          {!isConnected ? 'Connect to server first' : 
           sessionStarting.current ? 'Starting session...' :
           isRecording ? 'Recording... Click to stop' : 'Click to start recording'}
        </p>

        {/* Transcript */}
        <div style={styles.transcriptContainer}>
          <p style={styles.transcript}>
            {transcript || 'Transcript will appear here...'}
          </p>
        </div>

        {/* Debug info */}
        <div style={styles.debugInfo}>
          Queue: {chunkQueue.current.length} | Processing: {isProcessing.current ? 'Yes' : 'No'} | Chunks Stored: {audioChunks.current.length}
        </div>
      </div>
    </div>
  );
};

const styles = {
  container: {
    backgroundColor: '#1a1a1a',
    height: '100vh',
    width: '100vw',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    textAlign: 'center',
    fontFamily: 'Arial, sans-serif'
  },
  inner: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '15px',
    padding: '20px'
  },
  status: {
    padding: '8px 16px',
    borderRadius: '20px',
    fontSize: '14px',
    fontWeight: 'bold',
    color: 'white'
  },
  sessionInfo: {
    padding: '5px 12px',
    backgroundColor: '#333',
    borderRadius: '15px',
    fontSize: '12px',
    color: '#ccc'
  },
  micButton: {
    backgroundColor: '#fff',
    height: '180px',
    width: '180px',
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.3s ease',
    fontSize: '50px'
  },
  micIcon: {
    fontSize: '50px'
  },
  statusText: {
    fontSize: '16px',
    color: '#cccccc',
    margin: '10px 0'
  },
  transcriptContainer: {
    backgroundColor: '#2d2d2d',
    borderRadius: '10px',
    padding: '20px',
    maxWidth: '80vw',
    maxHeight: '35vh',
    overflow: 'auto',
    border: '1px solid #444'
  },
  transcript: {
    fontSize: '16px',
    lineHeight: '1.5',
    color: '#00ffcc',
    margin: 0,
    textAlign: 'left'
  },
  debugInfo: {
    fontSize: '10px',
    color: '#666',
    fontFamily: 'monospace'
  }
};

export default MicRecorder;