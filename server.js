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
    const order = req.body; // { name, phone, lessons: [{id, qty}] }
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
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server after DB connection
connectDB().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});
