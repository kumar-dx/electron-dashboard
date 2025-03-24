const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Stream = require('node-rtsp-stream');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const FormData = require('form-data');
require('dotenv').config();
require('@electron/remote/main').initialize();

let mainWindow;
let stream;
let capturedFrames = [];
let captureInterval;
let uploadInterval;
let ffmpegProcess;
let appConfig = null;

// Platform-specific configurations
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Configuration paths
const configPath = path.join(app.getPath('userData'), 'config.json');

// Default configuration from environment variables
const defaultConfig = {
    baseUrl: process.env.BASE_URL,
    frameCaptureInterval: parseInt(process.env.FRAME_CAPTURE_INTERVAL || '30000', 10),
    frameUploadInterval: parseInt(process.env.FRAME_UPLOAD_INTERVAL || '300000', 10),
    apiKey: process.env.API_KEY
};

// Ensure required environment variables are available
if (!process.env.BASE_URL) {
    console.error('BASE_URL is not set in environment variables');
    app.quit();
}

if (!process.env.API_KEY) {
    console.error('API_KEY is not set in environment variables');
    app.quit();
}

async function loadConfig() {
    try {
        let savedConfig = {};
        if (fsSync.existsSync(configPath)) {
            const configData = await fs.readFile(configPath, 'utf8');
            savedConfig = JSON.parse(configData);
        }

        // Only use store ID and RTSP URL from saved config
        appConfig = {
            ...defaultConfig,
            storeId: savedConfig.storeId,
            rtspUrl: savedConfig.rtspUrl
        };

        return appConfig;
    } catch (error) {
        console.error('Error loading config:', error);
        appConfig = { ...defaultConfig };
        return appConfig;
    }
}

async function saveConfig(config) {
    try {
        // Only save store ID and RTSP URL
        const configToSave = {
            storeId: config.storeId,
            rtspUrl: config.rtspUrl
        };

        // Keep environment variables in memory but don't save them
        appConfig = {
            ...defaultConfig,
            ...configToSave
        };

        await fs.writeFile(configPath, JSON.stringify(configToSave, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving config:', error);
        throw error;
    }
}

// Configuration
const config = {
    frameCapturePath: path.join(app.getPath('userData'), 'captured_frames'),
    ffmpegPath: isWindows ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg',
    iconPath: path.join(__dirname, 'assets', 'icon.ico')
};

// Create images directory if it doesn't exist
if (!fsSync.existsSync(config.frameCapturePath)) {
    fsSync.mkdirSync(config.frameCapturePath, { recursive: true });
}

// Add this function to handle cleanup
async function cleanupAndUploadRemaining() {
    // Stop the stream if running
    if (stream) {
        stream.stop();
        stream = null;
    }

    // Clear intervals
    if (captureInterval) clearInterval(captureInterval);
    if (uploadInterval) clearInterval(uploadInterval);

    // Upload any remaining frames
    if (capturedFrames.length > 0) {
        console.log(`Uploading ${capturedFrames.length} remaining frames before exit...`);
        try {
            await uploadFrames();
        } catch (error) {
            console.error('Error uploading remaining frames:', error);
        }
    }

    // Check for any files in the capture directory that might have been missed
    try {
        const files = await fs.readdir(config.frameCapturePath);
        const imageFiles = files.filter(file => file.startsWith('frame_') && file.endsWith('.jpg'));
        
        if (imageFiles.length > 0) {
            console.log(`Found ${imageFiles.length} additional images in directory, uploading...`);
            for (const file of imageFiles) {
                const filePath = path.join(config.frameCapturePath, file);
                try {
                    const data = await fs.readFile(filePath);
                    capturedFrames.push({
                        timestamp: new Date().toISOString(),
                        data: data,
                        path: filePath
                    });
                } catch (err) {
                    console.error(`Error reading file ${filePath}:`, err);
                }
            }
            
            if (capturedFrames.length > 0) {
                await uploadFrames();
            }
        }
    } catch (error) {
        console.error('Error checking for remaining files:', error);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: config.iconPath,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false,
            enableRemoteModule: true
        }
    });

    require('@electron/remote/main').enable(mainWindow.webContents);
    
    mainWindow.loadFile('index.html');
    
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    // Prevent window from closing directly
    mainWindow.on('close', async (e) => {
        if (stream || capturedFrames.length > 0) {
            e.preventDefault();
            const choice = await dialog.showMessageBox(mainWindow, {
                type: 'warning',
                buttons: ['Stop Stream and Upload Remaining Images', 'Cancel'],
                defaultId: 0,
                title: 'Confirm Exit',
                message: stream 
                    ? 'The stream is still running and there might be images to upload. Do you want to stop it and upload remaining images?'
                    : 'There are still images to upload. Do you want to upload them before exiting?'
            });
            
            if (choice.response === 0) {
                try {
                    // Show uploading dialog
                    mainWindow.webContents.send('show-upload-progress');
                    
                    // Cleanup and upload remaining images
                    await cleanupAndUploadRemaining();
                    
                    mainWindow.destroy();
                } catch (error) {
                    console.error('Error during cleanup:', error);
                    dialog.showMessageBox(mainWindow, {
                        type: 'error',
                        title: 'Error',
                        message: 'There was an error uploading remaining images. Some images might not have been uploaded.'
                    }).then(() => mainWindow.destroy());
                }
            }
        }
    });
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (isWindows) {
    app.setAppUserModelId(process.execPath);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (!isMac) {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Update the stop-stream handler to also handle remaining uploads
ipcMain.on('stop-stream', async () => {
    if (stream || capturedFrames.length > 0) {
        try {
            await cleanupAndUploadRemaining();
            mainWindow.webContents.send('stream-stopped');
        } catch (error) {
            console.error('Error stopping stream:', error);
            mainWindow.webContents.send('stream-error', error.message);
        }
    }
});

// Update the before-quit handler
app.on('before-quit', async (e) => {
    if (stream || capturedFrames.length > 0) {
        e.preventDefault();
        if (mainWindow) {
            mainWindow.focus();
        }
    }
});

function captureFrame(rtspUrl) {
    return new Promise((resolve, reject) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = path.join(config.frameCapturePath, `frame_${timestamp}.jpg`);
        
        const ffmpegArgs = [
            '-y',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-vframes', '1',
            '-q:v', '1',
            '-vf', 'scale=1280:720,format=yuv420p',
            '-update', '1',
            '-f', 'image2',
            outputPath
        ];

        const ffmpeg = spawn(config.ffmpegPath, ffmpegArgs, {
            windowsHide: true // Prevent command window from showing on Windows
        });

        let ffmpegError = '';

        ffmpeg.on('close', async (code) => {
            if (code === 0) {
                try {
                    const data = await fs.readFile(outputPath);
                    resolve({ data, path: outputPath });
                } catch (err) {
                    reject(new Error(`Failed to read captured frame: ${err.message}`));
                }
            } else {
                reject(new Error(`FFmpeg process failed with code ${code}: ${ffmpegError}`));
            }
        });

        ffmpeg.stderr.on('data', (data) => {
            ffmpegError += data.toString();
            console.log(`FFmpeg stderr: ${data}`);
        });

        ffmpeg.on('error', (error) => {
            reject(new Error(`Failed to start FFmpeg: ${error.message}`));
        });
    });
}

ipcMain.on('start-stream', (event, rtspUrl) => {
    if (!appConfig) {
        event.sender.send('stream-error', 'Configuration not loaded. Please configure the application first.');
        return;
    }

    if (stream) {
        stream.stop();
    }

    if (captureInterval) clearInterval(captureInterval);
    if (uploadInterval) clearInterval(uploadInterval);

    try {
        stream = new Stream({
            name: 'camera',
            streamUrl: rtspUrl,
            wsPort: 9999,
            host: 'localhost',
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
        }, appConfig.frameCaptureInterval);

        // Start upload interval
        uploadInterval = setInterval(async () => {
            if (capturedFrames.length > 0) {
                await uploadFrames();
            }
        }, appConfig.frameUploadInterval);

    } catch (error) {
        console.error('Error starting stream:', error);
        event.sender.send('stream-error', error.message);
    }
});

async function uploadFrames() {
  if (!appConfig || capturedFrames.length === 0) {
    return;
  }

  try {
    const headers = {
      'X-API-KEY': appConfig.apiKey
    };

    const framesToUpload = [...capturedFrames];
    capturedFrames = [];

    for (const frame of framesToUpload) {
      try {
        // Check if file exists before trying to upload
        try {
          await fs.access(frame.path);
        } catch (err) {
          console.log(`File ${frame.path} no longer exists, skipping...`);
          continue;
        }

        const formData = new FormData();
        formData.append('timestamp', frame.timestamp);
        
        const imageBuffer = Buffer.from(frame.data);
        formData.append('images', imageBuffer, {
          filename: path.basename(frame.path),
          contentType: 'image/jpeg'
        });

        const apiEndpoint = `${appConfig.baseUrl}/api/v1/analytics/stores/${appConfig.storeId}/upload-images/`;
        
        const response = await axios.post(apiEndpoint, formData, { 
          headers: {
            ...headers,
            ...formData.getHeaders()
          },
          timeout: 30000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        console.log(`Successfully uploaded frame from: ${frame.path}`);
        
        // Delete the file after successful upload
        try {
          await fs.unlink(frame.path);
          console.log(`Successfully deleted file: ${frame.path}`);
        } catch (deleteError) {
          console.error(`Error deleting file ${frame.path}:`, deleteError.message);
          // Even if delete fails, we don't need to retry the upload
        }
      } catch (error) {
        let shouldRetry = false;
        let errorMessage = '';

        if (error.response) {
          errorMessage = `Server Error (${error.response.status}): ${JSON.stringify(error.response.data)}`;
          shouldRetry = error.response.status >= 500;
        } else if (error.request) {
          errorMessage = `No response received: ${error.code || 'Unknown error'}`;
          shouldRetry = ['ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT'].includes(error.code);
        } else {
          errorMessage = `Request setup error: ${error.message}`;
          shouldRetry = false;
        }

        console.error(`Error uploading frame from ${frame.path}: ${errorMessage}`);
        
        if (shouldRetry) {
          // Check if file still exists before adding back to queue
          try {
            await fs.access(frame.path);
            console.log(`Adding frame back to queue for retry: ${frame.path}`);
            capturedFrames.push(frame);
          } catch (err) {
            console.log(`File ${frame.path} no longer exists, skipping retry...`);
          }
        } else {
          console.log(`Skipping retry for frame: ${frame.path}`);
          try {
            const errorLogPath = path.join(config.frameCapturePath, 'failed_uploads.log');
            await fs.appendFile(
              errorLogPath,
              `${new Date().toISOString()} - ${frame.path} - ${errorMessage}\n`
            );
            
            // Try to delete failed upload file to free up space
            try {
              await fs.unlink(frame.path);
              console.log(`Deleted failed upload file: ${frame.path}`);
            } catch (deleteError) {
              console.error(`Error deleting failed upload file ${frame.path}:`, deleteError.message);
            }
          } catch (logError) {
            console.error('Failed to write to error log:', logError);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in uploadFrames:', error);
    // Only add frames back to queue if they still exist
    for (const frame of framesToUpload) {
      try {
        await fs.access(frame.path);
        capturedFrames.push(frame);
      } catch (err) {
        console.log(`File ${frame.path} no longer exists, skipping retry...`);
      }
    }
  }
}

// Add a function to get the images directory path
ipcMain.handle('get-images-dir', () => {
  return config.frameCapturePath;
});

// Handle IPC events for configuration
ipcMain.handle('load-config', async () => {
    return await loadConfig();
});

ipcMain.handle('save-config', async (event, newConfig) => {
    await saveConfig(newConfig);
    return true;
}); 