require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory database (for simplicity - in production use a real database)
let users = [];
let categories = [];
let images = [];

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max file size
  abortOnLimit: true
}));

// Session management
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Set to true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Initialize with default admin user
async function initializeAdmin() {
  const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
  users.push({
    id: 1,
    username: process.env.ADMIN_USERNAME || 'admin',
    password: hashedPassword,
    isAdmin: true
  });
  console.log('Default admin user created');
}

initializeAdmin();

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

function isAdmin(req, res, next) {
  if (req.session.userId && req.session.isAdmin) {
    return next();
  }
  res.status(403).json({ error: 'Admin access required' });
}

// Routes

// Sign up
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: users.length + 1,
      username,
      password: hashedPassword,
      isAdmin: users.length === 0 // First user is admin
    };

    users.push(newUser);
    res.json({ message: 'User created successfully', isAdmin: newUser.isAdmin });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.isAdmin;

    res.json({ 
      message: 'Login successful', 
      isAdmin: user.isAdmin,
      username: user.username 
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out successfully' });
});

// Check auth status
app.get('/api/check-auth', (req, res) => {
  if (req.session.userId) {
    res.json({ 
      authenticated: true, 
      isAdmin: req.session.isAdmin,
      username: req.session.username 
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Create category (admin only)
app.post('/api/categories', isAdmin, (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Category name required' });
    }

    const newCategory = {
      id: categories.length + 1,
      name,
      createdAt: new Date()
    };

    categories.push(newCategory);
    res.json(newCategory);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all categories
app.get('/api/categories', (req, res) => {
  res.json(categories);
});

// Upload image (admin only)
app.post('/api/upload', isAdmin, (req, res) => {
  try {
    if (!req.files || !req.files.image) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const { categoryId } = req.body;
    const image = req.files.image;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(image.mimetype)) {
      return res.status(400).json({ error: 'Only image files allowed' });
    }

    // Generate unique filename
    const fileName = Date.now() + '-' + image.name.replace(/\s/g, '-');
    const uploadPath = path.join(__dirname, 'uploads', fileName);

    // Move file to uploads directory
    image.mv(uploadPath, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to upload image' });
      }

      const newImage = {
        id: images.length + 1,
        fileName,
        originalName: image.name,
        categoryId: parseInt(categoryId),
        uploadedBy: req.session.username,
        uploadedAt: new Date(),
        path: '/uploads/' + fileName
      };

      images.push(newImage);
      res.json(newImage);
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all images
app.get('/api/images', (req, res) => {
  const { categoryId } = req.query;
  
  let filteredImages = images;
  if (categoryId) {
    filteredImages = images.filter(img => img.categoryId === parseInt(categoryId));
  }
  
  res.json(filteredImages);
});

// Download image (admin only)
app.get('/api/download/:id', isAdmin, (req, res) => {
  try {
    const imageId = parseInt(req.params.id);
    const image = images.find(img => img.id === imageId);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const filePath = path.join(__dirname, 'uploads', image.fileName);
    res.download(filePath, image.originalName);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete image (admin only)
app.delete('/api/images/:id', isAdmin, (req, res) => {
  try {
    const imageId = parseInt(req.params.id);
    const imageIndex = images.findIndex(img => img.id === imageId);

    if (imageIndex === -1) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = images[imageIndex];
    const filePath = path.join(__dirname, 'uploads', image.fileName);

    // Delete file from disk
    fs.unlinkSync(filePath);

    // Remove from array
    images.splice(imageIndex, 1);

    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});
// Self-ping to prevent sleeping
const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;

cron.schedule('*/14 * * * *', async () => {
  try {
    console.log('⏰ Pinging server to prevent sleep...');
    const response = await fetch(RENDER_URL);
    const status = response.status;
    console.log(`✅ Ping successful! Status: ${status}`);
  } catch (error) {
    console.error('❌ Ping failed:', error.message);
  }
});

console.log('🔔 Cron job initialized - Server will self-ping every 14 minutes');

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin login: ${process.env.ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD}`);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin login: ${process.env.ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD}`);
});