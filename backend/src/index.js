const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const gmbRoutes = require('./routes/gmb');
const postsRoutes = require('./routes/posts');
const insightsRoutes = require('./routes/insights');
const reviewsRoutes = require('./routes/reviews');
const servicesRoutes = require('./routes/services');
const cacheRoutes = require('./routes/cache');
const aiRoutes = require('./routes/ai');
const clientLogRoutes = require('./routes/clientLog');
const apiLogger = require('./middleware/apiLogger');

const app = express();
const PORT = process.env.PORT || 3001;

// Railway / Vercel front-proxy: trust X-Forwarded-* so express-rate-limit can
// see the real client IP and CORS/cookies behave correctly.
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS allowlist:
//   - localhost ports for dev
//   - post-to-app.vercel.app + Vercel preview URLs
//   - www.post-to.app + apex
// Override via CORS_ORIGINS env var (comma-separated exact origins).
const CORS_ALLOWED_PATTERNS = [
  /^http:\/\/localhost:(3000|3001|3002|3003)$/,
  /^https:\/\/post-to-app(-[a-z0-9-]+)?\.vercel\.app$/,
  /^https:\/\/post-to-app-git-[a-z0-9-]+\.vercel\.app$/,
  /^https:\/\/(www\.)?post-to\.app$/
];
const CORS_EXTRA = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, server-to-server
    if (CORS_EXTRA.includes(origin)) return cb(null, true);
    if (CORS_ALLOWED_PATTERNS.some(re => re.test(origin))) return cb(null, true);
    return cb(new Error('CORS: origin not allowed: ' + origin));
  },
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API logging middleware
app.use(apiLogger);

// Routes
app.use('/auth', authRoutes);
app.use('/api/gmb', gmbRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/client-log', clientLogRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit - keep server running
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
