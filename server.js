// server.js
// Full-Stack After-School Club Backend
// Features: Public lesson browsing, cart checkout, admin panel with CRUD for lessons and order management

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT;

// Middleware
app.use(express.json());
app.use(cors());

// Logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Static images function
app.get('/images/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'public/images', req.params.filename);
  res.sendFile(filePath, (err) => {
    if (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'Image not found' });
      return res.status(500).json({ error: 'Error serving image' });
    }
  });
});

// MongoDB
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('afterschool');
    console.log('Connected to MongoDB Atlas');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
}

// Normalize lessons
function normalizeLessons(lessons) {
  return lessons.map(l => ({ ...l, totalSpace: l.space }));
}

// ***** AUTH *****
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ user: username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: 'Invalid/expired token' });
  }
}

// ***** PUBLIC ROUTES *****

app.get('/lessons', async (req, res) => {
  try {
    const lessons = await db.collection('lessons').find({}).toArray();
    res.json(normalizeLessons(lessons));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/search', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    const conditions = [
      { topic: { $regex: q, $options: 'i' } },
      { location: { $regex: q, $options: 'i' } }
    ];
    const num = Number(q);
    if (!isNaN(num)) conditions.push({ price: num }, { space: num });
    const lessons = await db.collection('lessons').find({ $or: conditions }).toArray();
    res.json(normalizeLessons(lessons));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ***** PLACE ORDER — decrements spaces on server *****
app.post('/orders', async (req, res) => {
  try {
    const { name, phone, lessons, notes } = req.body;

    // Validation
    if (!name || !/^[A-Za-z\s]{2,50}$/.test(name))
      return res.status(400).json({ error: 'Invalid name' });
    if (!phone || !/^0\d{10}$/.test(phone))
      return res.status(400).json({ error: 'Invalid phone' });
    if (!Array.isArray(lessons) || lessons.length === 0)
      return res.status(400).json({ error: 'Select at least one lesson' });

    // Decrease spaces
    for (const l of lessons) {
      const result = await db.collection('lessons').updateOne(
        { _id: new ObjectId(l.id), space: { $gte: l.qty } },
        { $inc: { space: -l.qty } }
      );
      if (result.matchedCount === 0)
        return res.status(400).json({ error: `Not enough space for lesson ${l.id}` });
    }

    const order = {
      name,
      phone,
      lessons: lessons.map(l => ({ lessonId: new ObjectId(l.id), qty: l.qty })),
      notes: notes || '',
      status: 'pending',
      createdAt: new Date()
    };

    const result = await db.collection('orders').insertOne(order);
    res.json({ insertedId: result.insertedId });

  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ***** ADMIN ROUTES *****
// All routes below require valid JWT token via verifyToken middleware
// View all orders
app.get('/orders', verifyToken, async (req, res) => {
  try {
    const orders = await db.collection('orders')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search orders
app.get('/orders/search', verifyToken, async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.json([]);
  try {
    const results = await db.collection('orders').find({
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
        { notes: { $regex: q, $options: 'i' } },
        { _id: { $regex: q, $options: 'i' } }
      ]
    }).sort({ createdAt: -1 }).toArray();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark order as done
app.patch('/orders/:id/done', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const result = await db.collection('orders').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'done', completedAt: new Date() } }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ***** LESSONS ADMIN  *****

// Create lesson
app.post('/lessons', verifyToken, async (req, res) => {
  const { topic, location, price, space, icon } = req.body;
  if (!topic || !location || !icon) return res.status(400).json({ error: 'Missing fields' });
  if (typeof topic !== 'string' || topic.length > 50) return res.status(400).json({ error: 'Invalid topic' });
  if (typeof location !== 'string' || location.length > 50) return res.status(400).json({ error: 'Invalid location' });
  if (typeof price !== 'number' || price < 0) return res.status(400).json({ error: 'Invalid price' });
  if (typeof space !== 'number' || space < 0) return res.status(400).json({ error: 'Invalid space' });
  if (typeof icon !== 'string' || !icon.endsWith('.png')) return res.status(400).json({ error: 'Invalid icon' });

  try {
    const lesson = { topic, location, price, space, icon, totalSpace: space };
    const result = await db.collection('lessons').insertOne(lesson);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EDIT LESSON 
app.put('/lessons/:id', verifyToken, async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid lesson ID' });

  const update = req.body;
  const allowed = ['topic', 'location', 'price', 'space', 'icon'];
  const invalidKeys = Object.keys(update).filter(k => !allowed.includes(k));
  if (invalidKeys.length > 0) return res.status(400).json({ error: `Invalid fields: ${invalidKeys.join(', ')}` });

  try {
    // Validation
    if (update.topic && (typeof update.topic !== 'string' || update.topic.length > 50))
      return res.status(400).json({ error: 'Topic too long' });
    if (update.location && (typeof update.location !== 'string' || update.location.length > 50))
      return res.status(400).json({ error: 'Location too long' });
    if (update.price !== undefined && (typeof update.price !== 'number' || update.price < 0))
      return res.status(400).json({ error: 'Invalid price' });
    if (update.space !== undefined && (typeof update.space !== 'number' || update.space < 0))
      return res.status(400).json({ error: 'Invalid space' });
    if (update.icon && !update.icon.endsWith('.png'))
      return res.status(400).json({ error: 'Icon must be .png' });

    const result = await db.collection('lessons').updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete lesson
app.delete('/lessons/:id', verifyToken, async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const result = await db.collection('lessons').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ***** ICONS *****
const ICONS_DIR = path.join(__dirname, 'public/images');
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR);

const storage = multer.diskStorage({
  destination: ICONS_DIR,
  filename: (req, file, cb) => {
    if (!file.originalname.endsWith('.png')) return cb(new Error('Only .png allowed'));
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

app.get('/icons', async (req, res) => {
  try {
    const files = fs.readdirSync(ICONS_DIR);
    res.json(files.filter(f => f.endsWith('.png')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/icons', verifyToken, upload.single('file'), (req, res) => {
  res.json({ filename: req.file.originalname });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Start
connectDB().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
});