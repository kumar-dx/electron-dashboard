const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const WebSocket = require('ws');
const ffmpeg = require('fluent-ffmpeg');
const FormData = require('form-data');

// Set ffmpeg path based on platform
if (process.platform === 'win32') {
    const ffmpegPath = path.join(process.cwd(), 'ffmpeg', 'ffmpeg.exe');
    const ffprobePath = path.join(process.cwd(), 'ffmpeg', 'ffprobe.exe');
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
}

let mainWindow;
let ffmpegProcess;
let wss;
let imagesDir;

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Create images directory in user's home directory
    const userDataPath = app.getPath('userData');
    imagesDir = path.join(userDataPath, 'captured_frames');
    try {
        await fs.mkdir(imagesDir, { recursive: true });
        console.log('Images directory created:', imagesDir);
    } catch (error) {
        console.error('Error creating images directory:', error);
    }

    mainWindow.loadFile('index.html');
    mainWindow.webContents.openDevTools();
}

// Handle IPC messages
ipcMain.handle('get-images-dir', () => imagesDir);

ipcMain.on('start-stream', (event, rtspUrl) => {
    startStream(rtspUrl);
});

ipcMain.on('stop-stream', () => {
    stopStream();
});

function startStream(rtspUrl) {
    try {
        // Stop any existing stream
        stopStream();

        // Create WebSocket server
        wss = new WebSocket.Server({ port: 9999 });
        console.log('WebSocket server started on port 9999');

        wss.on('connection', (ws, req) => {
            console.log(`Client connected from ${req.socket.remoteAddress}`);
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
            });

            ws.on('close', () => {
                console.log(`Client from ${req.socket.remoteAddress} disconnected`);
            });
        });

        // Start FFmpeg process
        ffmpegProcess = ffmpeg(rtspUrl)
            .inputOptions([
                '-rtsp_transport', 'tcp',
                '-re'
            ])
            .outputOptions([
                '-f', 'image2',
                '-update', '1',
                '-pix_fmt', 'yuvj420p'
            ])
            .output(path.join(imagesDir, 'frame.jpg'))
            .on('start', (commandLine) => {
                console.log('FFmpeg started:', commandLine);
                mainWindow.webContents.send('stream-started');
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                mainWindow.webContents.send('stream-error', err.message);
                stopStream();
            })
            .on('end', () => {
                console.log('FFmpeg process ended');
                stopStream();
            });

        ffmpegProcess.run();

        // Watch for new frames
        const frameWatcher = fsSync.watch(imagesDir, (eventType, filename) => {
            if (filename === 'frame.jpg' && eventType === 'change') {
                try {
                    const frameData = fsSync.readFileSync(path.join(imagesDir, 'frame.jpg'));
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(frameData);
                        }
                    });
                } catch (error) {
                    console.error('Error reading frame:', error);
                }
            }
        });

        // Store watcher reference for cleanup
        wss.frameWatcher = frameWatcher;

    } catch (error) {
        console.error('Error starting stream:', error);
        mainWindow.webContents.send('stream-error', error.message);
    }
}

function stopStream() {
    // Stop FFmpeg process
    if (ffmpegProcess) {
        try {
            ffmpegProcess.kill('SIGKILL');
        } catch (error) {
            console.error('Error stopping FFmpeg:', error);
        }
        ffmpegProcess = null;
    }

    // Close WebSocket server
    if (wss) {
        // Stop file watcher
        if (wss.frameWatcher) {
            wss.frameWatcher.close();
        }

        // Close all client connections
        wss.clients.forEach((client) => {
            try {
                client.close();
            } catch (error) {
                console.error('Error closing client connection:', error);
            }
        });

        // Close server
        wss.close((err) => {
            if (err) {
                console.error('Error closing WebSocket server:', err);
            } else {
                console.log('WebSocket server closed');
            }
        });
        wss = null;
    }

    mainWindow.webContents.send('stream-stopped');
}

// App lifecycle events
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    stopStream();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Cleanup on app quit
app.on('before-quit', () => {
    stopStream();
}); 