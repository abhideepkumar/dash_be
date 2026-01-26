import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dashboard-ai-jwt-secret-key-2024';
const JWT_EXPIRES_IN = '7d';

/**
 * Middleware to authenticate JWT token
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Authentication required' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      });
    }
    
    req.user = decoded;
    next();
  });
}

/**
 * Generate JWT token for a user
 * @param {object} user - User document
 * @returns {string} JWT token
 */
export function generateToken(user) {
  return jwt.sign(
    { 
      userId: user._id, 
      email: user.email 
    }, 
    JWT_SECRET, 
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Optional auth - doesn't fail if no token, but attaches user if present
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (!err) {
      req.user = decoded;
    }
    next();
  });
}
