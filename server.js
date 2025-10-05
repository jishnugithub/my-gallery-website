require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const cron = require('node-cron');
const fetch = require('node-fetch');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// In-memory database (for simplicity - in production use a real database)
let users = [];
let categories = [];
let images = [];

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
  }
}));
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

// Upload image to Cloudinary (admin only)
app.post('/api/upload', isAdmin, async (req, res) => {
  try {
    if (!req.files || !req.files.image) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const { categoryId } = req.body;
    const image = req.files.image;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(image.mimetype)) {
      return res.status(400).json({ error: 'Only image files allowed' });
    }

    // Upload to Cloudinary using upload_stream
    const uploadPromise = new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'gallery_uploads',
          resource_type: 'auto',
          transformation: [
            { width: 1500, height: 1500, crop: 'limit' }
          ]
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );

      streamifier.createReadStream(image.data).pipe(uploadStream);
    });

    const result = await uploadPromise;

    const newImage = {
      id: images.length + 1,
      fileName: image.name,
      originalName: image.name,
      cloudinaryUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      categoryId: parseInt(categoryId),
      uploadedBy: req.session.username,
      uploadedAt: new Date(),
      path: result.secure_url // Use Cloudinary URL
    };

    images.push(newImage);
    res.json(newImage);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image to Cloudinary' });
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
app.get('/api/download/:id', isAdmin, async (req, res) => {
  try {
    const imageId = parseInt(req.params.id);
    const image = images.find(img => img.id === imageId);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Redirect to Cloudinary URL for download
    res.redirect(image.cloudinaryUrl);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete image (admin only)
app.delete('/api/images/:id', isAdmin, async (req, res) => {
  try {
    const imageId = parseInt(req.params.id);
    const imageIndex = images.findIndex(img => img.id === imageId);

    if (imageIndex === -1) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = images[imageIndex];

    // Delete from Cloudinary
    await cloudinary.uploader.destroy(image.cloudinaryPublicId);

    // Remove from array
    images.splice(imageIndex, 1);

    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete image' });
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
  console.log(`Admin login: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  console.log('Cloudinary configured for persistent image storage');
});