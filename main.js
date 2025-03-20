const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Stream = require('node-rtsp-stream');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');

let mainWindow;
let stream;
let capturedFrames = [];
let captureInterval;
let uploadInterval;
let ffmpegProcess;

// Create images directory if it doesn't exist
const imagesDir = path.join(app.getPath('userData'), 'captured_frames');
if (!fsSync.existsSync(imagesDir)) {
  fsSync.mkdirSync(imagesDir, { recursive: true });
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
    const outputPath = path.join(imagesDir, `frame_${timestamp}.jpg`);
    
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-vframes', '1',
      '-q:v', '1',
      '-vf', 'scale=1280:720',
      '-f', 'image2',
      '-pix_fmt', 'yuvj420p',
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
    stream = new Stream({
      name: 'camera',
      streamUrl: rtspUrl,
      wsPort: 9999,
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
        '-an': ''
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

    // Start frame capture interval (every 30 seconds)
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
        }
      }
    }, 30000);

    // Start upload interval (every 5 minutes)
    uploadInterval = setInterval(async () => {
      if (capturedFrames.length > 0) {
        await uploadFrames();
      }
    }, 300000);
  } catch (error) {
    console.error('Error starting stream:', error);
    mainWindow.webContents.send('stream-error', error.message);
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
  try {
    const apiEndpoint = 'http://localhost:8000/api/v1/analytics/process-local-images/';
    const headers = {
      'X-API-KEY': 'vrqouhciwtykfummlaqryyxexnkhtvvi',
      'Content-Type': 'application/json'
    };
    
    for (const frame of capturedFrames) {
      try {
        await axios.post(apiEndpoint, {
          timestamp: frame.timestamp,
          image: frame.data.toString('base64'),
          store_id: 111
        }, { headers });

        console.log(`Successfully uploaded frame from: ${frame.path}`);
      } catch (error) {
        console.error(`Error uploading frame from ${frame.path}:`, error.message);
      }
    }
    
    // Clear the frames array after upload attempts
    capturedFrames = [];
  } catch (error) {
    console.error('Error in uploadFrames:', error);
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
  return imagesDir;
}); 