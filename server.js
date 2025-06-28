const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const winston = require('winston');
const multer = require('multer');

// Load environment variables
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configure logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'fleet-management-server' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Create logs directory
fs.ensureDirSync('logs');

// Create uploads directory
fs.ensureDirSync('uploads');
fs.ensureDirSync('uploads/thumbnails');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads/';
        fs.ensureDirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept images, videos, and audio files
        if (file.mimetype.startsWith('image/') || 
            file.mimetype.startsWith('video/') || 
            file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Trust proxy for ngrok
app.set('trust proxy', 1);

// Rate limiting - updated for proxy support
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use X-Forwarded-For header if available (for ngrok)
    return req.headers['x-forwarded-for'] || req.ip;
  }
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CSP header middleware - must be before static and routes!
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data: https://cdn.jsdelivr.net https://*.tile.openstreetmap.org"
  );
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve the main UI at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory storage for dashcam data
const dashcamData = new Map();
const commandHistory = [];
const commandQueue = new Map();
const eventLog = [];
const mediaFiles = {
    images: [],
    videos: [],
    audio: []
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Handle dashcam registration
  socket.on('dashcam_register', (data) => {
    const { deviceId, deviceInfo } = data;
    dashcamData.set(deviceId, {
      ...deviceInfo,
      socketId: socket.id,
      lastSeen: new Date(),
      status: 'online',
      location: null,
      events: [],
      jt808Enabled: false
    });
    
    logger.info(`Dashcam registered: ${deviceId}`);
    io.emit('dashcam_status', {
      deviceId,
      status: 'online',
      timestamp: new Date()
    });
  });

  // Handle dashcam events
  socket.on('dashcam_event', (data) => {
    const { deviceId, eventType, eventData } = data;
    const dashcam = dashcamData.get(deviceId);
    
    if (dashcam) {
      dashcam.lastSeen = new Date();
      dashcam.events.push({
        type: eventType,
        data: eventData,
        timestamp: new Date()
      });
      
      eventLog.push({
        deviceId,
        eventType,
        eventData,
        timestamp: new Date()
      });
      
      logger.info(`Dashcam event: ${deviceId} - ${eventType}`);
      io.emit('dashcam_event', {
        deviceId,
        eventType,
        eventData,
        timestamp: new Date()
      });
    }
  });

  // Handle location updates
  socket.on('location_update', (data) => {
    const { deviceId, location } = data;
    const dashcam = dashcamData.get(deviceId);
    
    if (dashcam) {
      dashcam.location = location;
      dashcam.lastSeen = new Date();
      
      io.emit('location_update', {
        deviceId,
        location,
        timestamp: new Date()
      });
    }
  });

  // Handle command responses
  socket.on('command_response', (data) => {
    const { commandId, deviceId, response, success } = data;
    
    commandHistory.push({
      commandId,
      deviceId,
      response,
      success,
      timestamp: new Date()
    });
    
    logger.info(`Command response: ${commandId} - ${success ? 'SUCCESS' : 'FAILED'}`);
    io.emit('command_response', {
      commandId,
      deviceId,
      response,
      success,
      timestamp: new Date()
    });
  });

  // Handle heartbeat
  socket.on('heartbeat', (data) => {
    const { deviceId } = data;
    const dashcam = dashcamData.get(deviceId);
    
    if (dashcam) {
      dashcam.lastSeen = new Date();
      logger.debug(`Heartbeat received from: ${deviceId}`);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
    
    // Mark dashcam as offline
    for (const [deviceId, dashcam] of dashcamData.entries()) {
      if (dashcam.socketId === socket.id) {
        dashcam.status = 'offline';
        dashcam.socketId = null;
        
        io.emit('dashcam_status', {
          deviceId,
          status: 'offline',
          timestamp: new Date()
        });
        break;
      }
    }
  });

  // Relay 'get_location' command from dashboard to device
  socket.on('get_location', (data) => {
    const { deviceId } = data;
    const dashcam = dashcamData.get(deviceId);
    if (dashcam && dashcam.socketId) {
      io.to(dashcam.socketId).emit('get_location_request', { requestorSocketId: socket.id });
      logger.info(`Relayed 'get_location' command to device: ${deviceId}`);
    } else {
      socket.emit('location_error', { error: 'Device not connected', deviceId });
    }
  });

  // Device sends location in response to 'get_location_request'
  socket.on('location_response', (data) => {
    const { deviceId, location, requestorSocketId } = data;
    if (requestorSocketId) {
      io.to(requestorSocketId).emit('location_response', { deviceId, location });
      logger.info(`Forwarded location from device ${deviceId} to dashboard`);
    } else {
      // Fallback: broadcast to all dashboards (optional)
      io.emit('location_response', { deviceId, location });
    }
  });
});

// API Routes

// Health check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date(),
    uptime: process.uptime(),
    version: '1.0.0',
    connectedDevices: dashcamData.size,
    totalEvents: eventLog.length
  });
});

// Get all dashcams
app.get('/api/dashcams', (req, res) => {
  logger.info('[DEBUG] GET /api/dashcams called');
  const dashcams = Array.from(dashcamData.entries()).map(([deviceId, data]) => ({
    deviceId,
    status: data.status,
    lastSeen: data.lastSeen,
    location: data.location,
    jt808Enabled: data.jt808Enabled || false,
    model: data.model || 'Unknown',
    version: data.version || 'Unknown'
  }));
  logger.info(`[DEBUG] Returning ${dashcams.length} dashcams`);
  res.json(dashcams);
});

// Get specific dashcam
app.get('/api/dashcams/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const dashcam = dashcamData.get(deviceId);
  
  if (!dashcam) {
    logger.warn('[DEBUG] 404: Dashcam not found for deviceId ' + deviceId);
    return res.status(404).json({ error: 'Dashcam not found' });
  }
  
  res.json({
    deviceId,
    ...dashcam,
    jt808Data: dashcam.jt808Data || []
  });
});

// Register dashcam
app.post('/api/dashcams/register', (req, res) => {
  logger.info(`[DEBUG] POST /api/dashcams/register body: ${JSON.stringify(req.body)}`);
  const { deviceId, model, version } = req.body;
  if (!deviceId) {
    logger.warn('[DEBUG] 400: Device ID is required');
    return res.status(400).json({ error: 'Device ID is required' });
  }
  
  // Register or update device
  const dashcam = {
    deviceId,
    model: model || 'Unknown',
    version: version || 'Unknown',
    status: 'online',
    lastSeen: new Date(),
    registeredAt: new Date(),
    jt808Enabled: false
  };
  
  dashcamData.set(deviceId, dashcam);
  
  logger.info(`Device registered via HTTP: ${deviceId} (${model} ${version})`);
  res.json({ success: true, message: 'Device registered successfully' });
});

// Update dashcam status
app.post('/api/dashcams/:deviceId/status', (req, res) => {
  const { deviceId } = req.params;
  const { status, batteryLevel, storageAvailable, jt808Enabled } = req.body;
  
  const dashcam = dashcamData.get(deviceId);
  if (!dashcam) {
    return res.status(404).json({ error: 'Dashcam not found' });
  }
  
  dashcam.status = status || dashcam.status;
  dashcam.lastSeen = new Date();
  dashcam.batteryLevel = batteryLevel;
  dashcam.storageAvailable = storageAvailable;
  dashcam.jt808Enabled = jt808Enabled || dashcam.jt808Enabled;
  
  logger.info(`Status update: ${deviceId} - ${status}`);
  res.json({ success: true });
});

// Get pending commands for a device (polling endpoint)
app.get('/api/dashcams/:deviceId/commands', (req, res) => {
  const { deviceId } = req.params;
  logger.info(`[DEBUG] GET /api/dashcams/${deviceId}/commands - Device polling for commands`);
  
  const dashcam = dashcamData.get(deviceId);
  if (!dashcam) {
    logger.warn('[DEBUG] 404: Dashcam not found for deviceId ' + deviceId);
    return res.status(404).json({ error: 'Dashcam not found' });
  }
  
  // Get pending commands for this device
  const commands = commandQueue.get(deviceId) || [];
  
  // Clear the queue after sending
  commandQueue.set(deviceId, []);
  
  logger.info(`[DEBUG] Returning ${commands.length} commands to device ${deviceId}`);
  res.json(commands);
});

// Send command to dashcam
app.post('/api/dashcams/:deviceId/command', (req, res) => {
  logger.info(`[DEBUG] POST /api/dashcams/${req.params.deviceId}/command body: ${JSON.stringify(req.body)}`);
  const { deviceId } = req.params;
  const { command, parameters } = req.body;
  const dashcam = dashcamData.get(deviceId);
  if (!dashcam) {
    logger.warn('[DEBUG] 404: Dashcam not found for deviceId ' + deviceId);
    return res.status(404).json({ error: 'Dashcam not found' });
  }
  
  // Create command object
  const commandObj = {
    commandId: uuidv4(),
    command: command,
    parameters: parameters || {},
    timestamp: new Date(),
    status: 'pending'
  };
  
  // Add to command queue for the device
  if (!commandQueue.has(deviceId)) {
    commandQueue.set(deviceId, []);
  }
  commandQueue.get(deviceId).push(commandObj);
  
  logger.info(`[DEBUG] Command queued for device ${deviceId}: ${command} (ID: ${commandObj.commandId})`);
  
  // If device is connected via Socket.IO, send immediately
  if (dashcam.socketId) {
    io.to(dashcam.socketId).emit('command', commandObj);
    logger.info(`[DEBUG] Command sent via Socket.IO to device ${deviceId}`);
  }
  
  res.json({ 
    success: true, 
    message: 'Command queued successfully',
    commandId: commandObj.commandId
  });
});

// Dummy events endpoint to prevent dashboard errors
app.get('/api/events', (req, res) => {
  res.json({ events: [] });
});

// Add missing endpoints that the Android app expects

// Media upload endpoint
app.post('/api/dashcams/:deviceId/media', upload.single('media'), (req, res) => {
  const { deviceId } = req.params;
  const { eventType, type } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const mediaFile = {
    id: uuidv4(),
    deviceId,
    filename: req.file.filename,
    originalName: req.file.originalname,
    path: req.file.path,
    size: req.file.size,
    mimetype: req.file.mimetype,
    eventType: eventType || 'manual',
    type: type || 'unknown',
    uploadedAt: new Date()
  };
  
  // Store in appropriate category
  if (req.file.mimetype.startsWith('image/')) {
    mediaFiles.images.push(mediaFile);
  } else if (req.file.mimetype.startsWith('video/')) {
    mediaFiles.videos.push(mediaFile);
  } else if (req.file.mimetype.startsWith('audio/')) {
    mediaFiles.audio.push(mediaFile);
  }
  
  logger.info(`Media uploaded: ${deviceId} - ${req.file.originalname} (${req.file.size} bytes)`);
  res.json({ 
    success: true, 
    message: 'Media uploaded successfully',
    fileId: mediaFile.id,
    filename: mediaFile.filename
  });
});

// Photo upload endpoint
app.post('/api/dashcams/:deviceId/photo', upload.single('photo'), (req, res) => {
  const { deviceId } = req.params;
  const { eventType } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' });
  }
  
  const photoFile = {
    id: uuidv4(),
    deviceId,
    filename: req.file.filename,
    originalName: req.file.originalname,
    path: req.file.path,
    size: req.file.size,
    eventType: eventType || 'manual',
    uploadedAt: new Date()
  };
  
  mediaFiles.images.push(photoFile);
  
  logger.info(`Photo uploaded: ${deviceId} - ${req.file.originalname}`);
  res.json({ 
    success: true, 
    message: 'Photo uploaded successfully',
    fileId: photoFile.id
  });
});

// Video upload endpoint
app.post('/api/dashcams/:deviceId/video', upload.single('video'), (req, res) => {
  const { deviceId } = req.params;
  const { eventType } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ error: 'No video uploaded' });
  }
  
  const videoFile = {
    id: uuidv4(),
    deviceId,
    filename: req.file.filename,
    originalName: req.file.originalname,
    path: req.file.path,
    size: req.file.size,
    eventType: eventType || 'manual',
    uploadedAt: new Date()
  };
  
  mediaFiles.videos.push(videoFile);
  
  logger.info(`Video uploaded: ${deviceId} - ${req.file.originalname}`);
  res.json({ 
    success: true, 
    message: 'Video uploaded successfully',
    fileId: videoFile.id
  });
});

// Events endpoint
app.post('/api/dashcams/:deviceId/events', (req, res) => {
  const { deviceId } = req.params;
  const { eventType, description } = req.body;
  
  const event = {
    id: uuidv4(),
    deviceId,
    eventType,
    description,
    timestamp: new Date()
  };
  
  eventLog.push(event);
  
  // Update dashcam events
  const dashcam = dashcamData.get(deviceId);
  if (dashcam) {
    dashcam.events.push(event);
    dashcam.lastSeen = new Date();
  }
  
  logger.info(`Event logged: ${deviceId} - ${eventType}: ${description}`);
  res.json({ 
    success: true, 
    message: 'Event logged successfully',
    eventId: event.id
  });
});

// Location endpoint
app.post('/api/dashcams/:deviceId/location', (req, res) => {
  const { deviceId } = req.params;
  const { latitude, longitude, altitude, speed, bearing, accuracy, timestamp } = req.body;
  
  const location = {
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    altitude: parseFloat(altitude) || 0,
    speed: parseFloat(speed) || 0,
    bearing: parseFloat(bearing) || 0,
    accuracy: parseFloat(accuracy) || 0,
    timestamp: timestamp || new Date()
  };
  
  // Get or create dashcam entry
  let dashcam = dashcamData.get(deviceId);
  if (!dashcam) {
    // Auto-register device if it doesn't exist
    dashcam = {
      deviceId,
      model: 'Unknown',
      version: '1.0',
      status: 'online',
      lastSeen: new Date(),
      registeredAt: new Date(),
      location: null,
      events: [],
      jt808Enabled: false
    };
    dashcamData.set(deviceId, dashcam);
    logger.info(`Auto-registered device: ${deviceId} via location update`);
  }
  
  // Update dashcam location
  dashcam.location = location;
  dashcam.lastSeen = new Date();
  
  logger.info(`Location update: ${deviceId} - ${latitude}, ${longitude}`);
  res.json({ 
    success: true, 
    message: 'Location updated successfully'
  });
});

// Heartbeat endpoint
app.post('/api/dashcams/:deviceId/heartbeat', (req, res) => {
  const { deviceId } = req.params;
  const { batteryLevel, storageAvailable } = req.body;
  
  const dashcam = dashcamData.get(deviceId);
  if (dashcam) {
    dashcam.lastSeen = new Date();
    dashcam.batteryLevel = batteryLevel;
    dashcam.storageAvailable = storageAvailable;
  }
  
  logger.debug(`Heartbeat: ${deviceId}`);
  res.json({ 
    success: true, 
    message: 'Heartbeat received'
  });
});

// Get media files for a device
app.get('/api/dashcams/:deviceId/media', (req, res) => {
  const { deviceId } = req.params;
  const { type } = req.query;
  
  let files = [];
  if (type === 'images' || type === 'photos') {
    files = mediaFiles.images.filter(f => f.deviceId === deviceId);
  } else if (type === 'videos') {
    files = mediaFiles.videos.filter(f => f.deviceId === deviceId);
  } else if (type === 'audio') {
    files = mediaFiles.audio.filter(f => f.deviceId === deviceId);
  } else {
    files = [
      ...mediaFiles.images.filter(f => f.deviceId === deviceId),
      ...mediaFiles.videos.filter(f => f.deviceId === deviceId),
      ...mediaFiles.audio.filter(f => f.deviceId === deviceId)
    ];
  }
  
  res.json({ 
    deviceId,
    files: files.map(f => ({
      id: f.id,
      filename: f.filename,
      originalName: f.originalName,
      size: f.size,
      mimetype: f.mimetype,
      eventType: f.eventType,
      uploadedAt: f.uploadedAt
    }))
  });
});

// Get events for a device
app.get('/api/dashcams/:deviceId/events', (req, res) => {
  const { deviceId } = req.params;
  const deviceEvents = eventLog.filter(e => e.deviceId === deviceId);
  
  res.json({ 
    deviceId,
    events: deviceEvents
  });
});

// Get current location for a device
app.get('/api/dashcams/:deviceId/location', (req, res) => {
  const { deviceId } = req.params;
  const dashcam = dashcamData.get(deviceId);
  
  if (!dashcam) {
    return res.status(404).json({ 
      error: 'Device not found',
      deviceId 
    });
  }
  
  if (!dashcam.location) {
    return res.status(404).json({ 
      error: 'No location data available for this device',
      deviceId 
    });
  }
  
  res.json({ 
    deviceId,
    location: dashcam.location,
    lastSeen: dashcam.lastSeen,
    status: dashcam.status
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeConnections: Object.keys(io.sockets.sockets).length
  });
});

// JT808 Location endpoint
app.post('/api/dashcams/:deviceId/jt808/location', (req, res) => {
  const { deviceId } = req.params;
  const { latitude, longitude, altitude, speed, bearing, warnBit, statusBit, timestamp } = req.body;
  
  const location = {
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    altitude: parseFloat(altitude) || 0,
    speed: parseFloat(speed) || 0,
    bearing: parseFloat(bearing) || 0,
    warnBit: parseInt(warnBit) || 0,
    statusBit: parseInt(statusBit) || 0,
    timestamp: timestamp || new Date()
  };
  
  // Get or create dashcam entry
  let dashcam = dashcamData.get(deviceId);
  if (!dashcam) {
    // Auto-register device if it doesn't exist
    dashcam = {
      deviceId,
      model: 'Unknown',
      version: '1.0',
      status: 'online',
      lastSeen: new Date(),
      registeredAt: new Date(),
      location: null,
      events: [],
      jt808Enabled: true
    };
    dashcamData.set(deviceId, dashcam);
    logger.info(`Auto-registered device: ${deviceId} via JT808 location update`);
  }
  
  // Update dashcam location
  dashcam.location = location;
  dashcam.lastSeen = new Date();
  dashcam.jt808Enabled = true;
  
  // Store JT808 data
  if (!dashcam.jt808Data) {
    dashcam.jt808Data = [];
  }
  dashcam.jt808Data.push({
    type: 'location',
    data: location,
    timestamp: new Date()
  });
  
  logger.info(`JT808 Location update: ${deviceId} - ${latitude}, ${longitude} (warnBit: ${warnBit}, statusBit: ${statusBit})`);
  res.json({ 
    success: true, 
    message: 'JT808 location updated successfully'
  });
});

// JT808 Alert endpoint
app.post('/api/dashcams/:deviceId/jt808/alert', (req, res) => {
  const { deviceId } = req.params;
  const { alertType, warnBit, statusBit, latitude, longitude, altitude, speed, description, timestamp } = req.body;
  
  const alert = {
    id: uuidv4(),
    deviceId,
    alertType: alertType || 'unknown',
    warnBit: parseInt(warnBit) || 0,
    statusBit: parseInt(statusBit) || 0,
    location: {
      latitude: parseFloat(latitude) || 0,
      longitude: parseFloat(longitude) || 0,
      altitude: parseFloat(altitude) || 0,
      speed: parseFloat(speed) || 0
    },
    description: description || 'JT808 Alert',
    timestamp: timestamp || new Date()
  };
  
  // Get or create dashcam entry
  let dashcam = dashcamData.get(deviceId);
  if (!dashcam) {
    // Auto-register device if it doesn't exist
    dashcam = {
      deviceId,
      model: 'Unknown',
      version: '1.0',
      status: 'online',
      lastSeen: new Date(),
      registeredAt: new Date(),
      location: null,
      events: [],
      jt808Enabled: true
    };
    dashcamData.set(deviceId, dashcam);
    logger.info(`Auto-registered device: ${deviceId} via JT808 alert`);
  }
  
  // Update dashcam
  dashcam.lastSeen = new Date();
  dashcam.jt808Enabled = true;
  
  // Store JT808 data
  if (!dashcam.jt808Data) {
    dashcam.jt808Data = [];
  }
  dashcam.jt808Data.push({
    type: 'alert',
    data: alert,
    timestamp: new Date()
  });
  
  // Add to events
  dashcam.events.push({
    type: 'jt808_alert',
    data: alert,
    timestamp: new Date()
  });
  
  // Add to event log
  eventLog.push({
    deviceId,
    eventType: 'jt808_alert',
    eventData: alert,
    timestamp: new Date()
  });
  
  // Emit to connected clients
  io.emit('jt808_alert', {
    deviceId,
    alert,
    timestamp: new Date()
  });
  
  logger.info(`JT808 Alert: ${deviceId} - ${alertType} (warnBit: ${warnBit}, statusBit: ${statusBit})`);
  res.json({ 
    success: true, 
    message: 'JT808 alert received successfully',
    alertId: alert.id
  });
});

// Get JT808 data for a device
app.get('/api/dashcams/:deviceId/jt808', (req, res) => {
  const { deviceId } = req.params;
  const dashcam = dashcamData.get(deviceId);
  
  if (!dashcam) {
    return res.status(404).json({ 
      error: 'Device not found',
      deviceId 
    });
  }
  
  res.json({ 
    deviceId,
    jt808Enabled: dashcam.jt808Enabled || false,
    data: dashcam.jt808Data || []
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Fleet Management Server running on port ${PORT}`);
  console.log(`🚗 Fleet Management Server running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard available at: http://localhost:${PORT}`);
  console.log(`🔌 API endpoints available at: http://localhost:${PORT}/api`);
  console.log(`📡 Socket.IO endpoint: http://localhost:${PORT}`);
});