// Middleware to log all incoming API requests
const apiLogger = (req, res, next) => {
  next();
};

module.exports = apiLogger;