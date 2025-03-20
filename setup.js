const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const { platform } = process;

async function setupFFmpeg() {
    console.log('Setting up FFmpeg...');

    if (platform === 'win32') {
        // Windows setup
        const ffmpegDir = path.join(process.cwd(), 'ffmpeg');
        
        if (!fs.existsSync(ffmpegDir)) {
            fs.mkdirSync(ffmpegDir);
        }

        // Check if FFmpeg is already installed
        if (fs.existsSync(path.join(ffmpegDir, 'ffmpeg.exe'))) {
            console.log('FFmpeg already installed');
            return;
        }

        console.log('Downloading FFmpeg for Windows...');
        // You should download FFmpeg from a reliable source and extract it
        console.log('Please download FFmpeg from https://www.gyan.dev/ffmpeg/builds/ and extract ffmpeg.exe and ffprobe.exe to the ffmpeg directory');
        
    } else if (platform === 'darwin') {
        // macOS setup
        console.log('Checking if FFmpeg is installed on macOS...');
        
        exec('which ffmpeg', (error, stdout, stderr) => {
            if (error) {
                console.log('FFmpeg not found. Installing via Homebrew...');
                
                // Check if Homebrew is installed
                exec('which brew', (error, stdout, stderr) => {
                    if (error) {
                        console.log('Homebrew not found. Please install Homebrew first:');
                        console.log('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
                    } else {
                        // Install FFmpeg using Homebrew
                        exec('brew install ffmpeg', (error, stdout, stderr) => {
                            if (error) {
                                console.error('Error installing FFmpeg:', error);
                            } else {
                                console.log('FFmpeg installed successfully');
                            }
                        });
                    }
                });
            } else {
                console.log('FFmpeg is already installed');
            }
        });
    } else {
        console.log('Unsupported platform');
    }
}

setupFFmpeg(); 