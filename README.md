# Veronica - RTSP Camera Stream Dashboard

Veronica is a desktop application for capturing and uploading frames from RTSP camera streams. Built with Electron, it provides a simple and efficient way to monitor camera feeds and upload the captured frames to a server.

## Features

- Real-time frame capture from RTSP streams
- Automatic frame upload to server
- Configurable capture and upload intervals
- User-friendly interface
- Cross-platform support

## System Requirements

- Windows 10 or later
- FFmpeg installed and available in system PATH
- Internet connection for frame uploads

## Installation

1. Download the latest release from the releases page
2. Run the installer (Veronica-Setup-1.0.0.exe)
3. Follow the installation wizard
4. Launch Veronica from the desktop shortcut or Start menu

## Configuration

1. First Launch:
   - Enter your Store ID
   - Enter the RTSP URL for your camera
   - Click Save Configuration

2. Environment Variables (Optional):
   - `BASE_URL`: Your server's base URL
   - `API_KEY`: Your API key for authentication
   - `FRAME_CAPTURE_INTERVAL`: Time between frame captures (default: 30000ms)
   - `FRAME_UPLOAD_INTERVAL`: Time between uploads (default: 300000ms)
   - `FFMPEG_PATH`: Path to FFmpeg executable (if not in PATH)

## Usage

1. Launch Veronica
2. Enter or verify your RTSP URL
3. Click "Start" to begin capturing
4. Monitor the status and frame counts
5. Click "Stop" to end capture

## Troubleshooting

1. FFmpeg Issues:
   - Ensure FFmpeg is installed and accessible
   - Check FFMPEG_PATH environment variable if needed

2. Connection Issues:
   - Verify RTSP URL is correct
   - Check network connectivity
   - Verify camera credentials

3. Upload Issues:
   - Check server connectivity
   - Verify API key is correct
   - Check server logs for errors

## Support

For support or issues, please contact your system administrator or the DriveX support team.

## License

This project is licensed under the MIT License - see the LICENSE file for details. 