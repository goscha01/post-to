// Middleware to log all incoming API requests
const apiLogger = (req, res, next) => {
  console.log(`🌐 ${req.method} ${req.originalUrl}`);
  next();
};

module.exports = apiLogger;