require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Tesseract = require('tesseract.js');
const bcrypt = require('bcrypt');
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

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, 'uploads'),
  filename: (_, file, cb) => {
    const safeName = `${Date.now()}${path.extname(file.originalname)}`;
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) {
    console.log('No authorization header found');
    return res.sendStatus(401);
  }
  const token = auth.split(' ')[1];
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      console.error('Token verification error:', err);
      return res.sendStatus(403);
    }
    console.log('Decoded user:', user);
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

app.post('/upload', authenticateToken, (req, res, next) => {
  upload.single('image')(req, res, async (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      console.error('Multer error: File too large');
      return res.status(413).json({ error: 'File too large. Max size is 10MB.' });
    } else if (err) {
      console.error('Multer error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    }

    if (!req.file) {
      console.error('No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = path.join(__dirname, 'uploads', req.file.filename);
    console.log(`Processing file: ${filePath}`);
    try {
      const { data: { text } } = await Tesseract.recognize(filePath, 'eng', { logger: m => console.log(m) });
      console.log(`OCR text extracted: ${text}`);
      const cleanText = text.replace(/"/g, '\"').replace(/\n/g, ' ');

      const py = spawn('python', [path.join(__dirname, 'python', 'predictor.py'), cleanText]);
      let stdout = '', stderr = '';
      py.stdout.on('data', chunk => {
        stdout += chunk;
        console.log(`Python stdout: ${chunk}`);
      });
      py.stderr.on('data', chunk => {
        stderr += chunk;
        console.error(`Python stderr: ${chunk}`);
      });

      py.on('close', code => {
        fs.unlinkSync(filePath);
        console.log(`Python process exited with code ${code}`);
        if (code !== 0) {
          console.error('⚠ Python stderr:', stderr);
          return res.status(500).json({ error: 'NER failed' });
        }
        try {
          const result = JSON.parse(stdout);
          console.log(`Parsed result: ${JSON.stringify(result)}`);
          res.json({
            ocrText: text,
            cleanedText: result.cleaned_text,
            medicines: result.medicines
          });
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
      'SELECT * FROM medicines WHERE user_email = ?',
      [req.user.email]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

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
    console.error('Error saving medicines:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// New endpoint to update a medicine
app.put('/update-medicine/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, dosage, notificationId } = req.body;

  try {
    const [rows] = await pool.execute(
      'SELECT * FROM medicines WHERE id = ? AND user_email = ?',
      [id, req.user.email]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Medicine not found or unauthorized' });
    }

    await pool.execute(
      'UPDATE medicines SET name = ?, dosage = ?, notification_id = ? WHERE id = ? AND user_email = ?',
      [name, dosage, notificationId || null, id, req.user.email]
    );

    res.status(200).json({ message: 'Medicine updated successfully' });
  } catch (err) {
    console.error('Error updating medicine:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on http://localhost:${port}`);
});