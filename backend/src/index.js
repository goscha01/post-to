const { initFixPrompt } = require('@fixprompt/node');
initFixPrompt({ key: process.env.FIXPROMPT_KEY });

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Routes
const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const connectionsRoutes = require('./routes/connections');
const analyticsRoutes = require('./routes/analytics');
const aiRoutes = require('./routes/ai');
const calendarRoutes = require('./routes/calendar');
const socialRoutes = require('./routes/social');
const gmbRoutes = require('./routes/gmb');
const insightsRoutes = require('./routes/insights');
const gscRoutes = require('./routes/gsc');
const googleAdsRoutes = require('./routes/googleAds');
const metaAdsRoutes = require('./routes/metaAds');
const openAiAdsRoutes = require('./routes/openAiAds');
const reviewsRoutes = require('./routes/reviews');
const servicesRoutes = require('./routes/services');
const blogsRoutes = require('./routes/blogs');
const feedsRoutes = require('./routes/feeds');
const driveRoutes = require('./routes/drive');
const cacheRoutes = require('./routes/cache');
const clientLogRoutes = require('./routes/clientLog');
const automationsRoutes = require('./routes/automations');
const campaignAssistantRoutes = require('./routes/campaignAssistant');
const appStoreConnectRoutes = require('./routes/appStoreConnect');
const optimizationReportRoutes = require('./routes/optimizationReport');

app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/gmb', gmbRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/gsc', gscRoutes);
app.use('/api/google-ads', googleAdsRoutes);
app.use('/api/meta-ads', metaAdsRoutes);
app.use('/api/openai-ads', openAiAdsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/blogs', blogsRoutes);
app.use('/api/feeds', feedsRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/client-log', clientLogRoutes);
app.use('/api/automations', automationsRoutes);
app.use('/api/campaign-assistant', campaignAssistantRoutes);
app.use('/api/app-store-connect', appStoreConnectRoutes);
app.use('/api/optimization-report', optimizationReportRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
