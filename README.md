# Android Dashcam Backend Server

Backend server for the Android fleet management app with real-time communication, file uploads, and device management.

## Features

- Device registration and status management
- Real-time Socket.IO communication
- File upload support (photos, videos)
- Command system for device control
- RESTful API endpoints
- Dashboard integration

## API Endpoints

- `GET /api/status` - Server health check
- `POST /api/dashcams/register` - Device registration
- `POST /api/dashcams/:id/status` - Status updates
- `POST /api/dashcams/:id/location` - Location updates
- `POST /api/dashcams/:id/events` - Event logging
- `GET /api/dashcams/:id/commands` - Poll for commands
- `POST /api/dashcams/:id/command` - Send command to device
- `POST /api/dashcams/:id/media` - File uploads
- `POST /api/dashcams/:id/photo` - Photo uploads
- `POST /api/dashcams/:id/video` - Video uploads

## Deployment

This server is configured for deployment on Render with the following settings:

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment**: Node.js
- **Port**: 10000

## Environment Variables

- `PORT` - Server port (default: 10000)
- `NODE_ENV` - Environment (production/development)
- `LOG_LEVEL` - Logging level
- `CORS_ORIGIN` - CORS origin
- `MAX_FILE_SIZE` - Maximum file upload size
- `UPLOAD_PATH` - File upload directory
