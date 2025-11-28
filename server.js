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

// Serve images
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

// ***** Auth Route for Admin Panel *****
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    // issue JWT with 1h expiry
    const token = jwt.sign({ user: username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Middleware to verify token (used only for admin routes)
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    jwt.verify(token, process.env.JWT_SECRET); // throws if expired/invalid
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token expired or invalid' });
  }
}

// ***** Customer Routes  *****

// Get all lessons
app.get('/lessons', async (req, res) => {
  try {
    const lessons = await db.collection('lessons').find({}).toArray();
    res.json(normalizeLessons(lessons));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Search lessons
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });
  try {
    const conditions = [
      { topic: { $regex: q, $options: 'i' } },
      { location: { $regex: q, $options: 'i' } }
    ];
    const num = Number(q);
    if (!isNaN(num)) { conditions.push({ price: num }); conditions.push({ space: num }); }
    const lessons = await db.collection('lessons').find({ $or: conditions }).toArray();
    res.json(normalizeLessons(lessons));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Place order
app.post('/orders', async (req, res) => {
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

    const order = { name, phone, lessons, notes: notes || '', createdAt: new Date() };
    const result = await db.collection('orders').insertOne(order);
    res.json({ insertedId: result.insertedId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update lesson (this is to decrement spaces after customers order)
app.put('/lessons/:id', async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid lesson ID' });
  const update = req.body;
  const allowed = ['topic', 'location', 'price', 'space', 'icon'];
  const invalidKeys = Object.keys(update).filter(k => !allowed.includes(k));
  if (invalidKeys.length > 0) {
    return res.status(400).json({ error: `Invalid fields: ${invalidKeys.join(', ')}` });
  }

  try {
    if (update.space !== undefined && (typeof update.space !== 'number' || update.space < 0)) {
      return res.status(400).json({ error: 'Space must be non‑negative number' });
    }
    if (update.price !== undefined && (typeof update.price !== 'number' || update.price < 0)) {
      return res.status(400).json({ error: 'Price must be non‑negative number' });
    }
    if (update.topic && (typeof update.topic !== 'string' || update.topic.length > 50)) {
      return res.status(400).json({ error: 'Topic must be string up to 50 chars' });
    }
    if (update.location && (typeof update.location !== 'string' || update.location.length > 50)) {
      return res.status(400).json({ error: 'Location must be string up to 50 chars' });
    }
    if (update.icon && (typeof update.icon !== 'string' || !update.icon.endsWith('.png'))) {
      return res.status(400).json({ error: 'Icon must be a .png filename' });
    }

    const result = await db.collection('lessons').updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Lesson not found' });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ***** Admin Routes *****

// List all orders
app.get('/orders', verifyToken, async (req, res) => {
  try {
    const orders = await db.collection('orders').find({}).toArray();
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

//  SEARCH ORDERS
app.get('/orders/search', verifyToken, async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.json([]);

  try {
    const results = await db.collection('orders').find({
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
        { notes: { $regex: q, $options: 'i' } },
        { _id: { $regex: q, $options: 'i' } } // allows searching by MongoID
      ]
    }).sort({ createdAt: -1 }).toArray();

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//  MARK ORDER AS DONE 
app.patch('/orders/:id/done', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }

  try {
    const result = await db.collection('orders').updateOne(
      { _id: new ObjectId(id) },
      { 
        $set: { 
          status: 'done',
          completedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
