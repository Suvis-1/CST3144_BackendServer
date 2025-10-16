const express = require('express')
const { MongoClient } = require('mongodb')
const path = require('path')
const app = express()
const port = process.env.PORT

// Middleware
app.use(express.json())  // For POST/PUT
app.use((req, res, next) => {  // Logger
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`)
  next()
})
app.use('/images', express.static(path.join(__dirname, 'public/images')))  // Static images
const uri = 'your-mongodb-atlas-uri' 
const client = new MongoClient(uri)

let db

async function connectDB() {
  try {
    await client.connect()
    db = client.db('afterschool')  // Database name
    console.log('Connected to MongoDB')
  } catch (err) {
    console.error('DB connection error:', err)
  }
}

connectDB()

// Routes
app.get('/lessons', async (req, res) => {
  try {
    const lessons = await db.collection('lessons').find({}).toArray()
    res.json(lessons)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/search', async (req, res) => {
  const q = req.query.q
  if (!q) return res.json([])
  try {
    const lessons = await db.collection('lessons').find({
      $or: [
        { topic: { $regex: q, $options: 'i' } },
        { location: { $regex: q, $options: 'i' } },
        { price: { $regex: q, $options: 'i' } },
        { space: { $regex: q, $options: 'i' } }
      ]
    }).toArray()
    res.json(lessons)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/orders', async (req, res) => {
  try {
    const order = req.body
    const result = await db.collection('orders').insertOne(order)
    res.json({ id: result.insertedId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/lessons/:id', async (req, res) => {
  const id = req.params.id
  const update = req.body  // e.g., { space: newSpace }
  try {
    const result = await db.collection('lessons').updateOne({ _id: new ObjectId(id) }, { $set: update })
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Lesson not found' })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(port, () => {
  console.log(`Server running on port ${port}`)
})