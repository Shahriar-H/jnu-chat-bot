const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
require('dotenv').config(); // Load .env variables

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const livebus = require("./livebus");
const testPush = require("./testPush");

const app = express();
app.use(express.json()); // Replaces body-parser
app.use(livebus); // Live bus location sharing endpoints
app.use(testPush); // FCM push test UI


// MongoDB connection
mongoose.connect("mongodb+srv://wa-shaki:wa-shaki22@cluster1.o9bisql.mongodb.net/jnuapp_db")
.then(() => console.log("MongoDB connected"))
.catch(err => console.log(err));

// Secret key for JWT
const SECRET = "mysecretkey";

/*
  No models used — directly using collection
*/
const User = mongoose.connection.collection("users");


// Register API
app.post("/register", async (req, res) => {
  try {
    const data = req.body;

    // Check if user exists
    const existing = await User.findOne({ email:data?.email });
    if (existing) {
      console.log("User already exists");
      
      return res.json({ message: "User already exists" });
    }

    // Hash password
    //const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    await User.insertOne(data);

    res.json({ message: "User registered" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Login API
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ message: "User not found" });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.json({ message: "Invalid password" });
    }

    // Create token
    const token = jwt.sign({ id: user._id }, SECRET, {
      expiresIn: "1h",
    });

    res.json({
      message: "Login successful",
      token,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//update user data
app.post("/update-user", async (req, res) => {
  try {
    const { email, newData } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ message: "User not found" });
    }

    // Update user data
    await User.updateOne({ email }, { $set: newData });

    res.json({ message: "User data updated" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Test protected route
app.get("/profile", async (req, res) => {
  try {
    const token = req.headers.authorization;

    if (!token) {
      return res.status(401).json({ message: "No token" });
    }

    const decoded = jwt.verify(token, SECRET);

    const user = await User.findOne({ _id: new mongoose.Types.ObjectId(decoded.id) });

    res.json({ user });

  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
});

// Load system prompt
const promptPath = path.resolve(__dirname, './Jnubus.txt');
const systemPrompt = fs.readFileSync(promptPath, 'utf-8');

// Validate environment variables
const { VERIFY_TOKEN, PAGE_ACCESS_TOKEN, GEMINI_API_KEY } = process.env;
if (!GEMINI_API_KEY) {
  throw new Error('Missing required environment variables in .env');
}

// In-memory session store
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Periodic session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.last_active > SESSION_TIMEOUT) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000); // Every 10 minutes

// Root route
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Facebook webhook verification
app.get('/facebook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden: This endpoint is for Facebook webhook verification only.');
  }
});

// Facebook webhook messages
app.post('/geaianswer', async (req, res) => {
  const body = req.body;
  try {
    const q = typeof req.body?.q === 'string' ? req.body.q.trim() : '';
    if (!q) return res.status(400).json({ error: 'Missing q (string prompt)' });
    // Gemini API call
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: q }]
          }
        ],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: 200 }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const reply = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text 
                        || 'Sorry, I couldn’t generate a response.';
    console.log(reply);
    res.send({reply:reply, status:200});

  } catch (error) {
    console.error('Gemini or Messenger API error:', error.response?.data || error.message);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(3001, () => {
  console.log('Server started on port 3001');
});
// Export for Vercel serverless
module.exports = app;
