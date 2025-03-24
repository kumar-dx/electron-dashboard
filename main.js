const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const FormData = require('form-data');
require('dotenv').config();
require('@electron/remote/main').initialize();

let mainWindow;
let capturedFrames = [];
let captureInterval;
let uploadInterval;
let ffmpegProcess;
let appConfig = null;
let isCapturing = false;
let uploadedFramesCount = 0;

// Platform-specific configurations
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Configuration paths
const configPath = path.join(app.getPath('userData'), 'config.json');

// FFmpeg path resolution
function findFFmpegPath() {
    // First check environment variable
    if (process.env.FFMPEG_PATH) {
        return process.env.FFMPEG_PATH;
    }

    // Common FFmpeg locations
    const possiblePaths = [
        'ffmpeg.exe', // In PATH
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(process.cwd(), 'ffmpeg.exe'), // In current directory
        path.join(__dirname, 'ffmpeg.exe'), // Next to main.js
    ];

    for (const ffmpegPath of possiblePaths) {
        try {
            if (fsSync.existsSync(ffmpegPath)) {
                return ffmpegPath;
            }
        } catch (error) {
            console.error(`Error checking FFmpeg path ${ffmpegPath}:`, error);
        }
    }

    return isWindows ? 'ffmpeg.exe' : 'ffmpeg'; // Default fallback
}

// Default configuration from environment variables
const defaultConfig = {
    baseUrl: process.env.BASE_URL || 'http://localhost:3000', // Default fallback
    frameCaptureInterval: parseInt(process.env.FRAME_CAPTURE_INTERVAL || '30000', 10), // 30 seconds
    frameUploadInterval: parseInt(process.env.FRAME_UPLOAD_INTERVAL || '300000', 10),
    apiKey: process.env.API_KEY || 'default-key' // Default fallback
};

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
    ffmpegPath: findFFmpegPath(),
    iconPath: path.join(__dirname, 'assets', 'icon.ico')
};

// Verify FFmpeg is available
async function verifyFFmpeg() {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(config.ffmpegPath, ['-version']);
        
        ffmpeg.on('error', (error) => {
            if (error.code === 'ENOENT') {
                reject(new Error(`FFmpeg not found at ${config.ffmpegPath}. Please install FFmpeg or set FFMPEG_PATH environment variable.`));
            } else {
                reject(error);
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(true);
            } else {
                reject(new Error(`FFmpeg test failed with code ${code}`));
            }
        });
    });
}

// Create images directory if it doesn't exist
if (!fsSync.existsSync(config.frameCapturePath)) {
    fsSync.mkdirSync(config.frameCapturePath, { recursive: true });
}

// Add this function to handle cleanup
async function cleanupAndUploadRemaining() {
    // Stop capturing if running
    if (isCapturing) {
        clearInterval(captureInterval);
        clearInterval(uploadInterval);
        isCapturing = false;
    }

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

async function createWindow() {
    try {
        // Load config first
        await loadConfig();
        
        // Then verify FFmpeg
        try {
            await verifyFFmpeg();
        } catch (error) {
            console.error('FFmpeg verification failed:', error);
            // Don't quit, just show warning
            await dialog.showMessageBox({
                type: 'warning',
                title: 'FFmpeg Warning',
                message: 'FFmpeg is not properly configured',
                detail: error.message + '\n\nPlease install FFmpeg or set the correct path in the FFMPEG_PATH environment variable.\n\nYou can still use the application, but frame capture will not work.'
            });
        }

        mainWindow = new BrowserWindow({
            width: 500,
            height: 360,
            resizable: false,
            minimizable: true,
            maximizable: true,
            autoHideMenuBar: true,
            title: 'Veronica | DriveX',
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
            if (isCapturing || capturedFrames.length > 0) {
                e.preventDefault();
                const choice = await dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    buttons: ['Stop Stream and Upload Remaining Images', 'Cancel'],
                    defaultId: 0,
                    cancelId: 1,
                    title: 'Confirm Exit',
                    message: 'There are frames being captured or pending upload.',
                    detail: 'Would you like to stop the stream and upload remaining images before exiting?'
                });

                if (choice.response === 0) {
                    await cleanupAndUploadRemaining();
                    mainWindow.destroy();
                }
            } else {
                mainWindow.destroy();
            }
        });
    } catch (error) {
        console.error('Error creating window:', error);
        await dialog.showMessageBox({
            type: 'error',
            title: 'Application Error',
            message: 'Failed to start application',
            detail: error.message + '\n\nPlease check the application logs for more details.'
        });
        app.quit();
    }
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
    if (isCapturing) {
        try {
            await cleanupAndUploadRemaining();
            mainWindow.webContents.send('stream-stopped');
        } catch (error) {
            console.error('Error stopping capture:', error);
            mainWindow.webContents.send('stream-error', error.message);
        }
    }
});

// Update the before-quit handler
app.on('before-quit', async (e) => {
    if (isCapturing || capturedFrames.length > 0) {
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
                let errorMessage = `FFmpeg process failed with code ${code}`;
                if (ffmpegError.includes('Connection refused')) {
                    errorMessage = 'Connection refused. Please check if the camera is online and accessible.';
                } else if (ffmpegError.includes('Connection timed out')) {
                    errorMessage = 'Connection timed out. Please check network connectivity.';
                } else if (ffmpegError.includes('Authentication failed')) {
                    errorMessage = 'Authentication failed. Please check camera credentials.';
                }
                reject(new Error(errorMessage));
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

async function startCapture() {
    if (isCapturing) return;
    
    try {
        // Start FFmpeg process
        ffmpegProcess = spawn(config.ffmpegPath, [
            '-i', appConfig.rtspUrl,
            '-vf', 'fps=1/30', // Capture one frame every 30 seconds
            '-frame_pts', '1',
            '-q:v', '2',
            '-f', 'image2',
            path.join(config.frameCapturePath, 'frame_%d.jpg')
        ]);

        ffmpegProcess.stderr.on('data', (data) => {
            console.log(`FFmpeg: ${data}`);
            // Check for common FFmpeg errors
            const errorMsg = data.toString();
            if (errorMsg.includes('Connection refused') || errorMsg.includes('Connection timed out')) {
                mainWindow.webContents.send('stream-error', 'Connection failed. Please check the RTSP URL and network connection.');
            } else if (errorMsg.includes('Authentication failed')) {
                mainWindow.webContents.send('stream-error', 'Authentication failed. Please check username and password in RTSP URL.');
            } else if (errorMsg.includes('No such file or directory')) {
                mainWindow.webContents.send('stream-error', 'Invalid RTSP URL. Please check the URL format.');
            }
        });

        ffmpegProcess.on('error', (error) => {
            console.error('FFmpeg process error:', error);
            mainWindow.webContents.send('stream-error', 'Failed to start FFmpeg. Please check if FFmpeg is installed correctly.');
            stopCapture();
        });

        ffmpegProcess.on('close', (code) => {
            console.log(`FFmpeg process exited with code ${code}`);
            if (code !== 0) {
                mainWindow.webContents.send('stream-error', `FFmpeg process exited with code ${code}. Please check the stream connection.`);
            }
            stopCapture();
        });

        // Capture first frame immediately
        await captureFrame();

        // Set up interval for subsequent captures
        captureInterval = setInterval(async () => {
            await captureFrame();
        }, appConfig.frameCaptureInterval);

        // Set up upload interval
        uploadInterval = setInterval(async () => {
            await uploadFrames();
        }, appConfig.frameUploadInterval);

        isCapturing = true;
        mainWindow.webContents.send('capture-status', { isCapturing: true });
    } catch (error) {
        console.error('Error starting capture:', error);
        mainWindow.webContents.send('stream-error', `Failed to start capture: ${error.message}`);
        stopCapture();
    }
}

ipcMain.on('start-stream', (event, rtspUrl) => {
    if (!appConfig) {
        event.sender.send('stream-error', 'Configuration not loaded. Please configure the application first.');
        return;
    }

    if (isCapturing) {
        clearInterval(captureInterval);
        clearInterval(uploadInterval);
    }

    isCapturing = true;
    uploadedFramesCount = 0;
    mainWindow.webContents.send('upload-stats', { uploadedFramesCount });

    try {
        // Start frame capture interval
        captureInterval = setInterval(async () => {
            if (isCapturing) {
                try {
                    const frame = await captureFrame(rtspUrl);
                    capturedFrames.push({
                        timestamp: new Date().toISOString(),
                        data: frame.data,
                        path: frame.path
                    });
                    console.log('Frame captured successfully and saved to:', frame.path);
                    event.sender.send('frame-captured');
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

        event.sender.send('stream-started');
    } catch (error) {
        console.error('Error starting capture:', error);
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
        uploadedFramesCount++;
        mainWindow.webContents.send('upload-stats', { uploadedFramesCount });
        
        // Delete the file after successful upload
        try {
          await fs.unlink(frame.path);
          console.log(`Successfully deleted file: ${frame.path}`);
        } catch (deleteError) {
          console.error(`Error deleting file ${frame.path}:`, deleteError.message);
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

// Add error handlers for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    dialog.showErrorBox('Application Error', error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
    dialog.showErrorBox('Application Error', error.message);
}); 