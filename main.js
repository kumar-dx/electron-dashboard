const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Stream = require('node-rtsp-stream');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const FormData = require('form-data');
require('dotenv').config();

let mainWindow;
let stream;
let capturedFrames = [];
let captureInterval;
let uploadInterval;
let ffmpegProcess;

// Configuration
const config = {
    apiEndpoint: process.env.API_ENDPOINT || 'http://localhost:8000/api/v1/analytics/process-local-images/',
    apiKey: process.env.API_KEY || 'vrqouhciwtykfummlaqryyxexnkhtvvi',
    storeId: parseInt(process.env.STORE_ID || '111', 10),
    frameCapturePath: path.join(app.getPath('userData'), 'captured_frames'),
    frameCaptureInterval: parseInt(process.env.FRAME_CAPTURE_INTERVAL || '30000', 10),
    frameUploadInterval: parseInt(process.env.FRAME_UPLOAD_INTERVAL || '300000', 10)
};

// Create images directory if it doesn't exist
if (!fsSync.existsSync(config.frameCapturePath)) {
    fsSync.mkdirSync(config.frameCapturePath, { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false // Required for WebSocket connection
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools(); // This will help us debug any issues
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function captureFrame(rtspUrl) {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(config.frameCapturePath, `frame_${timestamp}.jpg`);
    
    // Use platform-specific ffmpeg command
    const ffmpegCommand = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    
    const ffmpeg = spawn(ffmpegCommand, [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-vframes', '1',
      '-q:v', '1',
      '-vf', 'scale=1280:720,format=yuv420p',
      '-update', '1',
      '-f', 'image2',
      outputPath
    ]);

    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        try {
          const data = await fs.readFile(outputPath);
          resolve({ data, path: outputPath });
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });
  });
}

ipcMain.on('start-stream', (event, rtspUrl) => {
  if (stream) {
    stream.stop();
  }

  // Clear existing intervals if any
  if (captureInterval) clearInterval(captureInterval);
  if (uploadInterval) clearInterval(uploadInterval);

  try {
    // Use platform-specific host
    const host = process.platform === 'win32' ? 'localhost' : '127.0.0.1';
    
    stream = new Stream({
      name: 'camera',
      streamUrl: rtspUrl,
      wsPort: 9999,
      host: host,
      ffmpegOptions: {
        '-rtsp_transport': 'tcp',
        '-use_wallclock_as_timestamps': '1',
        '-fflags': '+genpts+igndts',
        '-c:v': 'mjpeg',
        '-pix_fmt': 'yuvj420p',
        '-f': 'mpjpeg',
        '-q:v': '2',
        '-r': '25',
        '-s': '1280x720',
        '-an': '',
        '-vf': 'format=yuv420p'
      }
    });

    console.log('Starting stream with options:', stream.options);

    stream.on('start', () => {
      console.log('Stream started');
      mainWindow.webContents.send('stream-started');
    });

    stream.on('data', (data) => {
      console.log('Stream data received, length:', data.length);
    });

    stream.on('error', (error) => {
      console.error('Stream error:', error);
      mainWindow.webContents.send('stream-error', error.message);
    });

    // Start frame capture interval
    captureInterval = setInterval(async () => {
      if (stream) {
        try {
          const frame = await captureFrame(rtspUrl);
          capturedFrames.push({
            timestamp: new Date().toISOString(),
            data: frame.data,
            path: frame.path
          });
          console.log('Frame captured successfully and saved to:', frame.path);
        } catch (error) {
          console.error('Error capturing frame:', error);
          event.sender.send('stream-error', `Frame capture error: ${error.message}`);
        }
      }
    }, config.frameCaptureInterval);

    // Start upload interval
    uploadInterval = setInterval(async () => {
      if (capturedFrames.length > 0) {
        await uploadFrames();
      }
    }, config.frameUploadInterval);
  } catch (error) {
    console.error('Error starting stream:', error);
    event.sender.send('stream-error', error.message);
  }
});

ipcMain.on('stop-stream', async () => {
  if (stream) {
    stream.stop();
    stream = null;

    // Clear intervals
    if (captureInterval) clearInterval(captureInterval);
    if (uploadInterval) clearInterval(uploadInterval);

    await uploadFrames();
    mainWindow.webContents.send('stream-stopped');
  }
});

async function uploadFrames() {
  if (capturedFrames.length === 0) {
    return;
  }

  try {
    const headers = {
      'X-API-KEY': config.apiKey
    };

    // Create a copy of frames to upload and clear the original array
    const framesToUpload = [...capturedFrames];
    capturedFrames = [];

    for (const frame of framesToUpload) {
      try {
        const formData = new FormData();
        formData.append('timestamp', frame.timestamp);
        
        // Create a Buffer from the image data and append it with the correct field name
        const imageBuffer = Buffer.from(frame.data);
        formData.append('images', imageBuffer, {
          filename: path.basename(frame.path),
          contentType: 'image/jpeg'
        });
        
        formData.append('store_id', config.storeId.toString());

        const response = await axios.post(config.apiEndpoint, formData, { 
          headers: {
            ...headers,
            ...formData.getHeaders()
          },
          timeout: 30000, // 30 second timeout
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        console.log(`Successfully uploaded frame from: ${frame.path}`);
        
        // Delete the file after successful upload
        try {
          await fs.unlink(frame.path);
        } catch (deleteError) {
          console.warn(`Warning: Could not delete frame file ${frame.path}:`, deleteError.message);
        }
      } catch (error) {
        let shouldRetry = false;
        let errorMessage = '';

        if (error.response) {
          // Server responded with error status
          errorMessage = `Server Error (${error.response.status}): ${JSON.stringify(error.response.data)}`;
          // Retry on 5xx server errors
          shouldRetry = error.response.status >= 500;
        } else if (error.request) {
          // Request made but no response received
          errorMessage = `No response received: ${error.code || 'Unknown error'}`;
          shouldRetry = ['ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT'].includes(error.code);
        } else {
          // Error in setting up the request
          errorMessage = `Request setup error: ${error.message}`;
          shouldRetry = false;
        }

        console.error(`Error uploading frame from ${frame.path}: ${errorMessage}`);
        
        if (shouldRetry) {
          console.log(`Adding frame back to queue for retry: ${frame.path}`);
          capturedFrames.push(frame);
        } else {
          console.log(`Skipping retry for frame: ${frame.path}`);
          try {
            const errorLogPath = path.join(config.frameCapturePath, 'failed_uploads.log');
            await fs.appendFile(
              errorLogPath,
              `${new Date().toISOString()} - ${frame.path} - ${errorMessage}\n`
            );
          } catch (logError) {
            console.error('Failed to write to error log:', logError);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in uploadFrames:', error);
    // Add frames back to queue if there's a catastrophic error
    capturedFrames = [...capturedFrames, ...framesToUpload];
  }
}

// Clean up on app quit
app.on('before-quit', () => {
  if (stream) {
    stream.stop();
  }
  if (captureInterval) clearInterval(captureInterval);
  if (uploadInterval) clearInterval(uploadInterval);
});

// Add a function to get the images directory path
ipcMain.handle('get-images-dir', () => {
  return config.frameCapturePath;
}); 