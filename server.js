// server.js
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT;

// Middleware
app.use(express.json()); // Parse JSON bodies
app.use(cors());         // Enable CORS for all origins

// Logger middleware
// Logs every request with timestamp, method, URL
app.use((req, res, next) => {
console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Static middleware for images
// Custom handler: serves images if they exist, otherwise returns JSON error
app.get('/images/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'public/images', req.params.filename);

  res.sendFile(filePath, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // File not found
        return res.status(404).json({ error: 'Image not found' });
      }
      // Some other error while trying to serve the file
      return res.status(500).json({ error: 'Error serving image' });
    }
  });
});

// MongoDB Connection
// Connects to MongoDB Atlas using the native driver
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('afterschool'); // Database name
    console.log('Connected to MongoDB Atlas');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
}

// Helper: normalize lessons by adding totalSpace field
function normalizeLessons(lessons) {
  return lessons.map(l => ({
    ...l,
    totalSpace: l.space
  }));
}

// ****Routes*****

// Get all lessons
// Returns all lessons as JSON
app.get('/lessons', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });
  try {
    const lessons = await db.collection('lessons').find({}).toArray();
    res.json(normalizeLessons(lessons));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hybrid search: matches topic/location (text) or price/space (numeric)
app.get('/search', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });

  try {
    const conditions = [
      { topic: { $regex: q, $options: 'i' } },
      { location: { $regex: q, $options: 'i' } }
    ];

    const num = Number(q);
    if (!isNaN(num)) {
      conditions.push({ price: num });
      conditions.push({ space: num });
    }

    const lessons = await db.collection('lessons').find({ $or: conditions }).toArray();
    res.json(normalizeLessons(lessons));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orders
// Validates and saves a new order, then decrements lesson availability
app.post('/orders', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });

  try {
    const { name, phone, lessons, notes } = req.body;

    // Validate name
    if (!name || !/^[A-Za-z\s]{2,50}$/.test(name)) {
      return res.status(400).json({ error: 'Name must be 2–50 letters only' });
    }

    // Validate UK phone number
    if (!phone || !/^0\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Phone must start with 0 and be exactly 11 digits' });
    }

    // Validate lessons
    if (!Array.isArray(lessons) || lessons.length === 0) {
      return res.status(400).json({ error: 'Lessons must be a non-empty array' });
    }
    for (const lesson of lessons) {
      if (!lesson.id || !ObjectId.isValid(lesson.id)) {
        return res.status(400).json({ error: 'Invalid lesson ID' });
      }
      if (!Number.isInteger(lesson.qty) || lesson.qty <= 0) {
        return res.status(400).json({ error: 'Quantity must be a positive integer' });
      }
    }

    // Validate notes
    if (notes && notes.length > 250) {
      return res.status(400).json({ error: 'Notes must be 250 characters or fewer' });
    }

    // Decrement availability
    for (const lesson of lessons) {
      const result = await db.collection('lessons').updateOne(
        { _id: new ObjectId(lesson.id), space: { $gte: lesson.qty } },
        { $inc: { space: -lesson.qty } }
      );
      if (result.matchedCount === 0) {
        return res.status(400).json({ error: `Not enough availability for lesson ${lesson.id}` });
      }
    }
    
    // Build order objects
    const order = { name, phone, lessons, notes: notes || '', createdAt: new Date() };
    
    // Insert orders into DB
    const result = await db.collection('orders').insertOne(order);

    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update lesson
// Updates lesson attributes with validation (e.g. no negative space/price)
app.put('/lessons/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });

  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid lesson ID' });
  }

  const update = req.body;
  const allowed = ['topic', 'location', 'price', 'space', 'icon'];
  const invalidKeys = Object.keys(update).filter(k => !allowed.includes(k));
  if (invalidKeys.length > 0) {
    return res.status(400).json({ error: `Invalid fields: ${invalidKeys.join(', ')}` });
  }

  try {
    // Field-specific validation
    if (update.space !== undefined) {
      if (typeof update.space !== 'number' || update.space < 0) {
        return res.status(400).json({ error: 'Space must be a non‑negative number' });
      }
    }
    if (update.price !== undefined) {
      if (typeof update.price !== 'number' || update.price < 0) {
        return res.status(400).json({ error: 'Price must be a non‑negative number' });
      }
    }
    if (update.topic && (typeof update.topic !== 'string' || update.topic.length > 50)) {
      return res.status(400).json({ error: 'Topic must be a string up to 50 characters' });
    }
    if (update.location && (typeof update.location !== 'string' || update.location.length > 50)) {
      return res.status(400).json({ error: 'Location must be a string up to 50 characters' });
    }
    if (update.icon && (typeof update.icon !== 'string' || !update.icon.endsWith('.png'))) {
      return res.status(400).json({ error: 'Icon must be a .png filename' });
    }

    // Perform update
    const result = await db.collection('lessons').updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    res.json(result);
  } catch (err) {
    if (err.code === 121) {
      return res.status(400).json({ error: 'Validation failed: ' + err.errmsg });
    }
    res.status(500).json({ error: err.message });
  }
});

// 404 fallback
// Handles any unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
// Connect to DB first, then start listening
connectDB().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});
