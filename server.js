// server.js
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT;

// Middleware
app.use(express.json()); // Parse JSON bodies

// CORS for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') res.sendStatus(200);
  else next();
});

// Logger middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - ${req.ip}`);
  next();
});

// Static middleware for images
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// MongoDB Connection
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

// Routes
app.get('/lessons', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });
  try {
    const lessons = await db.collection('lessons').find({}).toArray();
    res.json(lessons);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hybrid search: text and numeric
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
    res.json(lessons);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/orders', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });

  try {
    const { name, phone, lessons, notes } = req.body;

    // Validate name
    if (!name || !/^[A-Za-z\s]+$/.test(name)) {
      return res.status(400).json({ error: 'Name is required and must contain letters only' });
    }

    // Validate phone
    if (!phone || !/^\d+$/.test(phone)) {
      return res.status(400).json({ error: 'Phone is required and must contain numbers only' });
    }

    // Validate lessons
    if (!Array.isArray(lessons) || lessons.length === 0) {
      return res.status(400).json({ error: 'Lessons must be a non-empty array' });
    }
    for (const lesson of lessons) {
      if (!lesson.id || !lesson.qty || lesson.qty <= 0) {
        return res.status(400).json({ error: 'Each lesson must have a valid id and qty > 0' });
      }
    }

    // Validate notes (max 250 chars)
    if (notes && notes.length > 250) {
      return res.status(400).json({ error: 'Notes must be 250 characters or fewer' });
    }

    // Build order object
    const order = { name, phone, lessons, notes: notes || '' };

    // Insert into DB
    const result = await db.collection('orders').insertOne(order);

    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/lessons/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });

  const id = req.params.id;
  const update = req.body;
  try {
    const result = await db.collection('lessons').updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 fallback
app.use('/images', express.static(path.join(__dirname, 'public/images')), (req, res) => {
  res.status(404).json({ error: 'Image not found' });
});

// Start server after DB connection
connectDB().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});
