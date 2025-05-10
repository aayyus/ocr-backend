require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Tesseract = require('tesseract.js');
const bcrypt = require("bcryptjs")
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY;
if (!SECRET_KEY) {
  console.error('❌ SECRET_KEY is not defined in .env');
  process.exit(1);
}

app.use(express.json());
app.use(cors({ origin: '*', credentials: true }));

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ocr_app',
};
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

// ✅ Multer storage config with increased file size limit
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, 'uploads'),
  filename: (_, file, cb) => {
    const safeName = `${Date.now()}${path.extname(file.originalname)}`;
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 🔥 Increased from 5MB to 10MB
});
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

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

// ✅ Updated upload route
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
      const { data: { text } } = await Tesseract.recognize(filePath, 'eng', { logger: m => console.log(m) });
      const cleanText = text.replace(/"/g, '\"').replace(/\n/g, ' ');

      const py = spawn('python', [path.join(__dirname, 'python', 'predictor.py'), cleanText]);
      let stdout = '', stderr = '';
      py.stdout.on('data', chunk => stdout += chunk);
      py.stderr.on('data', chunk => stderr += chunk);

      py.on('close', code => {
        fs.unlinkSync(filePath);
        if (code !== 0) {
          console.error('⚠️ Python stderr:', stderr);
          return res.status(500).json({ error: 'NER failed' });
        }
        try {
          const meds = JSON.parse(stdout);
          res.json({ ocrText: text, medicines: meds });
        } catch (err) {
          console.error('❌ JSON parse error:', err);
          res.status(500).json({ error: 'Failed to parse NER output' });
        }
      });
    } catch (err) {
      fs.unlinkSync(filePath);
      console.error('❌ OCR processing error:', err);
      res.status(500).json({ error: 'OCR failed' });
    }
  });
});

app.get('/saved-medicines', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM medicines WHERE user_email = ? ORDER BY time ASC',
      [req.user.email]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/saved-medicines', authenticateToken, async (req, res) => {
 
  const { name, dosage, time } = req.body;
  try {
    await pool.execute(
      'INSERT INTO medicines (user_email, name, dosage, time) VALUES (?, ?, ?, ?)',
      [req.user.email, name, dosage, time]
    );
    res.json({ message: 'Saved' });
  } catch (err) {
    console.error("error",err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on http://localhost:${port}`);
});
