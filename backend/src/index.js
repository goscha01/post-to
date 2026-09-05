const { initFixPrompt } = require('@fixprompt/node');
initFixPrompt({ key: process.env.FIXPROMPT_KEY });

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Routes
const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const connectionsRoutes = require('./routes/connections');
const analyticsRoutes = require('./routes/analytics');
const aiRoutes = require('./routes/ai');
const calendarRoutes = require('./routes/calendar');
const socialRoutes = require('./routes/social');
const gmbRoutes = require('./routes/gmb');
const blogsRoutes = require('./routes/blogs');
const feedsRoutes = require('./routes/feeds');
const driveRoutes = require('./routes/drive');
const servicesRoutes = require('./routes/services');
const reviewsRoutes = require('./routes/reviews');
const insightsRoutes = require('./routes/insights');
const cacheRoutes = require('./routes/cache');
const gscRoutes = require('./routes/gsc');
const googleAdsRoutes = require('./routes/googleAds');
const metaAdsRoutes = require('./routes/metaAds');
const openAiAdsRoutes = require('./routes/openAiAds');
const appStoreConnectRoutes = require('./routes/appStoreConnect');
const automationsRoutes = require('./routes/automations');
const campaignAssistantRoutes = require('./routes/campaignAssistant');
const optimizationReportRoutes = require('./routes/optimizationReport');
const clientLogRoutes = require('./routes/clientLog');

app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/gmb', gmbRoutes);
app.use('/api/blogs', blogsRoutes);
app.use('/api/feeds', feedsRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/gsc', gscRoutes);
app.use('/api/google-ads', googleAdsRoutes);
app.use('/api/meta-ads', metaAdsRoutes);
app.use('/api/openai-ads', openAiAdsRoutes);
app.use('/api/app-store-connect', appStoreConnectRoutes);
app.use('/api/automations', automationsRoutes);
app.use('/api/campaign-assistant', campaignAssistantRoutes);
app.use('/api/optimization-report', optimizationReportRoutes);
app.use('/api/client-log', clientLogRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
