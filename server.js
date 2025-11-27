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
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Serve images
app.get('/images/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'public/images', req.params.filename);
  res.sendFile(filePath, err => {
    if (err) res.status(404).json({ error: 'Image not found' });
  });
});

// MongoDB
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db;

async function connectDB() {
  await client.connect();
  db = client.db('afterschool');
  console.log('Connected to MongoDB Atlas');

  // Create counters collection if not exists
  const counters = db.collection('counters');
  await counters.updateOne(
    { _id: 'orderNumber' },
    { $setOnInsert: { seq: 0 } },
    { upsert: true }
  );
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
  const lessons = await db.collection('lessons').find({}).toArray();
  res.json(normalizeLessons(lessons));
});

app.get('/search', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: 'Query required' });

  const conditions = [
    { topic: { $regex: q, $options: 'i' } },
    { location: { $regex: q, $options: 'i' } }
  ];
  const num = Number(q);
  if (!isNaN(num)) conditions.push({ price: num }, { space: num });

  const lessons = await db.collection('lessons').find({ $or: conditions }).toArray();
  res.json(normalizeLessons(lessons));
});

// ***** PLACE ORDER  *****
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

    // Generate order number
    const counter = await db.collection('counters').findOneAndUpdate(
      { _id: 'orderNumber' },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true }
    );
    const orderNumber = `ORD-${new Date().getFullYear()}-${String(counter.value.seq).padStart(4, '0')}`;

    const order = {
      orderNumber,
      name,
      phone,
      lessons: lessons.map(l => ({ lessonId: new ObjectId(l.id), qty: l.qty })),
      notes: notes || '',
      status: 'pending', 
      createdAt: new Date()
    };

    const result = await db.collection('orders').insertOne(order);
    res.json({ insertedId: result.insertedId, orderNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ***** ADMIN ROUTES *****
app.get('/orders', verifyToken, async (req, res) => {
  const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
  res.json(orders);
});

// Search orders (admin)
app.get('/orders/search', verifyToken, async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.json([]);

  const results = await db.collection('orders').find({
    $or: [
      { orderNumber: { $regex: q, $options: 'i' } },
      { name: { $regex: q, $options: 'i' } },
      { phone: { $regex: q, $options: 'i' } },
      { notes: { $regex: q, $options: 'i' } }
    ]
  }).toArray();

  res.json(results);
});

// Mark order as done
app.patch('/orders/:id/done', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

  const result = await db.collection('orders').updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'done', completedAt: new Date() } }
  );

  if (result.matchedCount === 0) return res.status(404).json({ error: 'Order not found' });
  res.json({ success: true });
});

// List all orders
app.get('/orders', verifyToken, async (req, res) => {
  try {
    const orders = await db.collection('orders').find({}).toArray();
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create new lesson
app.post('/lessons', verifyToken, async (req, res) => {
  const { topic, location, price, space, icon } = req.body;

  if (!topic || !location || !icon) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (typeof topic !== 'string' || topic.length > 50) {
    return res.status(400).json({ error: 'Topic must be string up to 50 chars' });
  }
  if (typeof location !== 'string' || location.length > 50) {
    return res.status(400).json({ error: 'Location must be string up to 50 chars' });
  }
  if (typeof price !== 'number' || price < 0) {
    return res.status(400).json({ error: 'Price must be non‑negative number' });
  }
  if (typeof space !== 'number' || space < 0) {
    return res.status(400).json({ error: 'Space must be non‑negative number' });
  }
  if (typeof icon !== 'string' || !icon.endsWith('.png')) {
    return res.status(400).json({ error: 'Icon must be a .png filename' });
  }

  try {
    const lesson = { topic, location, price, space, icon, totalSpace: space };
    const result = await db.collection('lessons').insertOne(lesson);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete lesson
app.delete('/lessons/:id', verifyToken, async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid lesson ID' });
  try {
    const result = await db.collection('lessons').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Icons management
const ICONS_DIR = path.join(__dirname, 'public/images');
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR);

const storage = multer.diskStorage({
  destination: ICONS_DIR,
  filename: (req, file, cb) => {
    if (!file.originalname.endsWith('.png')) {
      return cb(new Error('Only .png files allowed'));
    }
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

app.get('/icons', async (req, res) => {
  try {
    const files = fs.readdirSync(ICONS_DIR);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/icons', verifyToken, upload.single('file'), (req, res) => {
  res.json({ filename: req.file.originalname });
});

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Start server
connectDB().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
});
