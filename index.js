// Load environment variables from .env file
require('dotenv').config();

// Import required modules
const express = require('express');
const mysql = require('mysql2/promise');          // MySQL with promise support
const multer = require('multer');                 // Middleware for file uploads
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');       // To run Python script
const Tesseract = require('tesseract.js');        // OCR engine
const bcrypt = require('bcrypt');                 // Password hashing
const jwt = require('jsonwebtoken');              // Token-based authentication
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY;

// Exit if SECRET_KEY is not defined
if (!SECRET_KEY) {
  console.error('❌ SECRET_KEY is not defined in .env');
  process.exit(1);
}

// Middleware
app.use(express.json()); // Parse JSON bodies
app.use(cors({ origin: '*', credentials: true })); // Enable CORS

// MySQL configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ocr_app',
};

// Create MySQL connection pool
let pool;
(async () => {
  try {
    pool = await mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 10 });
    console.log('✅ Connected to MySQL');
  } catch (err) {
    console.error('❌ MySQL connection error:', err);
    process.exit(1);
  }
})();

// Set up file upload destination and naming strategy
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, 'uploads'),
  filename: (_, file, cb) => {
    const safeName = `${Date.now()}${path.extname(file.originalname)}`;
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// Ensure upload folder exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Middleware to authenticate JWT token
function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.sendStatus(401);
  const token = auth.split(' ')[1];

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// User registration endpoint
app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const [rows] = await pool.execute('SELECT 1 FROM users WHERE email = ?', [email]);
    if (rows.length) return res.status(409).json({ error: 'User already exists' });

    const hash = await bcrypt.hash(password, 10);
    await pool.execute('INSERT INTO users (email, password, name) VALUES (?, ?, ?)', [email, hash, name]);
    res.json({ message: 'Registered' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// User login endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    if (!await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ email: user.email, name: user.name }, SECRET_KEY, { expiresIn: '2h' });
    res.json({ token, user: { email: user.email, name: user.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Fetch authenticated user's profile
app.get('/profile', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT email, name FROM users WHERE email = ?', [req.user.email]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Upload image and run OCR + Python-based NER
app.post('/upload', authenticateToken, (req, res, next) => {
  upload.single('image')(req, res, async (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Max size is 10MB.' });
    } else if (err) {
      return res.status(500).json({ error: 'Upload failed' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = path.join(__dirname, 'uploads', req.file.filename);
    try {
      // Perform OCR
      const { data: { text } } = await Tesseract.recognize(filePath, 'eng');
      const cleanText = text.replace(/"/g, '\"').replace(/\n/g, ' ');

      // Run Python NER script
      const py = spawn('python', [path.join(__dirname, 'python', 'predictor.py'), cleanText]);
      let stdout = '', stderr = '';
      py.stdout.on('data', chunk => stdout += chunk);
      py.stderr.on('data', chunk => stderr += chunk);

      py.on('close', code => {
        fs.unlinkSync(filePath); // Delete uploaded file

        if (code !== 0) {
          return res.status(500).json({ error: 'NER failed' });
        }

        try {
          const result = JSON.parse(stdout);
          res.json({
            ocrText: text,
            cleanedText: result.cleaned_text,
            medicines: result.medicines
          });
        } catch (err) {
          res.status(500).json({ error: 'Failed to parse NER output' });
        }
      });
    } catch (err) {
      fs.unlinkSync(filePath);
      res.status(500).json({ error: 'OCR failed' });
    }
  });
});

// Fetch saved medicines for the authenticated user
app.get('/saved-medicines', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM medicines WHERE user_email = ?',
      [req.user.email]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Save medicines to database
app.post('/save-medicines', authenticateToken, async (req, res) => {
  try {
    const medicines = req.body.medicines;
    if (!medicines || !Array.isArray(medicines)) {
      return res.status(400).json({ error: 'Medicines array is required' });
    }

    const insertQuery = 'INSERT INTO medicines (user_email, name, dosage, notification_id) VALUES (?, ?, ?, ?)';
    for (const medicine of medicines) {
      await pool.execute(insertQuery, [
        req.user.email,
        medicine.name,
        medicine.dosage,
        medicine.notificationId || null,
      ]);
    }

    res.status(200).json({ message: 'Medicines saved successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Update a specific medicine by ID
app.put('/update-medicine/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, dosage, notificationId } = req.body;

  try {
    // Check if the medicine belongs to the user
    const [rows] = await pool.execute(
      'SELECT * FROM medicines WHERE id = ? AND user_email = ?',
      [id, req.user.email]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Medicine not found or unauthorized' });
    }

    // Update medicine info
    await pool.execute(
      'UPDATE medicines SET name = ?, dosage = ?, notification_id = ? WHERE id = ? AND user_email = ?',
      [name, dosage, notificationId || null, id, req.user.email]
    );

    res.status(200).json({ message: 'Medicine updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`✅ Server listening on http://localhost:${port}`);
});
