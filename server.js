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

function normalizeLessons(lessons) {
  return lessons.map(l => ({
    ...l,
    totalSpace: l.space
  }));
}

// Routes
app.get('/lessons', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not connected' });
  try {
    const lessons = await db.collection('lessons').find({}).toArray();
    res.json(normalizeLessons(lessons));
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
    res.json(normalizeLessons(lessons));
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

    // Validate UK phone number
    if (!phone || !/^0\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Phone must start with 0 and be exactly 11 digits' });
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

    // Validate notes
    if (notes && notes.length > 250) {
      return res.status(400).json({ error: 'Notes must be 250 characters or fewer' });
    }

    // Decrement availability for each lesson
    for (const lesson of lessons) {
      const result = await db.collection('lessons').updateOne(
        { _id: new ObjectId(lesson.id), space: { $gte: lesson.qty } },
        { $inc: { space: -lesson.qty } }
      );

      if (result.matchedCount === 0) {
        return res.status(400).json({ error: `Not enough availability for lesson ${lesson.id}` });
      }
    }

    // Build order object
    const order = { name, phone, lessons, notes: notes || '', createdAt: new Date() };

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

// 404 fallback for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server after DB connection
connectDB().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});
