# The Best Afterschool Lessons Booking API

This is the **backend API** for the Afterschool Lessons Booking App.  
It is built with **Express.js** and connects to **MongoDB Atlas**.  
The API provides endpoints for managing lessons, searching, and processing orders.

---

## ✨ Features

- 📚 **Lessons API**: Fetch all lessons with availability and details  
- 🔍 **Search API**: Query lessons by subject, location, price, or availability  
- 🛒 **Orders API**: Submit orders and automatically update lesson availability  
- 🖼️ **Static assets**: Serves lesson icons and images from `/public/images`  
- 🌐 **CORS enabled**: Configured for frontend integration  
- 🗄️ **MongoDB Atlas**: Stores lessons and orders  

---

## 🛠️ Tech Stack

- **Runtime:** Node.js  
- **Framework:** Express.js  
- **Database:** MongoDB Atlas  
- **Middleware:** CORS, dotenv, JSON body parsing  

---

## 📂 Project Structure

```
.
├── server.js          # Entry point for Express server
├── package.json       # Dependencies & scripts
├── public/
│   └── images/        # Static lesson icons
└── .env               # Environment variables (not committed)
```

---

## 🔄 API Endpoints

### Lessons

- `GET /lessons`  
  Returns all lessons with `totalSpace` field normalized.

- `PUT /lessons/:id`  
  Update a lesson by ID.

### Search

- `GET /search?q=keyword`  
  - Matches by `topic` or `location` (case insensitive).  
  - If `q` is numeric, also matches `price` or `space`.

### Orders

- `POST /orders`  
  - **Request body:**
    ```json
    {
      "name": "John Doe",
      "phone": "07123456789",
      "lessons": [
        { "id": "lessonId1", "qty": 2 },
        { "id": "lessonId2", "qty": 1 }
      ],
      "notes": "Optional notes"
    }
    ```
  - **Validates:**
    - Name (letters only)  
    - Phone (UK format: starts with 0, 11 digits)  
    - Lessons array (non-empty, valid IDs, qty > 0)  
    - Notes ≤ 250 characters  
  - **Behavior:**  
    Decrements lesson availability (`space`).  
    Inserts order into `orders` collection.  
  - **Response:**
    ```json
    { "insertedId": "..." }
    ```

---

## 🚀 Project Setup

### Install Dependencies

```sh
npm install
```

### Run in Development

```sh
node server.js
```

### Run with Nodemon (Optional)

```sh
npm run dev
```

---

## 🌐 Deployment

- Hosted on Render (Node server)  
- Connected to MongoDB Atlas  
- Frontend communicates with this API via `VITE_API_URL`  

---

## 📖 Environment Variables

Create a `.env` file in the project root:

```
PORT=5000
MONGODB_URI=your-mongodb-atlas-uri
```

---

## 📜 License

This project is licensed under the MIT License.  
See the [LICENSE](LICENSE) file for details.