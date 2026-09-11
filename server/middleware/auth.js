const db = require('../database/query');

const isDev = process.env.NODE_ENV !== 'production';

// Authentication middleware
function authenticate(req, res, next) {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');

  if (!sessionToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (isDev) console.log('Auth middleware: Checking session token');

  (async () => {
    try {
      const session = await db.get(
        `SELECT us.*, u.username, u.full_name, u.role, u.branch_id AS user_branch_id, u.is_active,
                b.id AS branch_table_id, b.name AS branch_name, b.code AS branch_code, b.branch_type AS branch_branch_type
         FROM user_sessions us
         JOIN users u ON us.user_id = u.id
         LEFT JOIN branches b ON b.id = COALESCE(us.branch_id, u.branch_id)
         WHERE us.session_token = $1 AND us.expires_at > CURRENT_TIMESTAMP AND COALESCE(u.is_active::int, 0) != 0`,
        [sessionToken]
      );

      if (!session) {
        if (isDev) console.log('Auth middleware: Invalid or expired session');
        return res.status(401).json({ error: 'Invalid or expired session' });
      }

      if (isDev) console.log('Auth middleware: Session valid for user:', session.username);

      // Prefer users.branch_id so branch managers keep their branch even if session.branch_id is unset
      const resolvedBranchId =
        session.user_branch_id != null ? session.user_branch_id : session.branch_id;

      // Attach user and branch info to request
      req.user = {
        id: session.user_id,
        username: session.username,
        fullName: session.full_name,
        role: session.role,
        branchId: resolvedBranchId != null ? resolvedBranchId : null
      };

      if (resolvedBranchId != null) {
        req.branch = {
          id: session.branch_table_id ?? resolvedBranchId,
          name: session.branch_name,
          code: session.branch_code,
          branchType: session.branch_branch_type
        };
      }

      // Effective branch for data isolation: admin can send X-Branch-Id or ?branch_id to view one branch; else all branches (admin) or user's branch
      if (req.user.role === 'admin') {
        const headerBranch = req.headers['x-branch-id'];
        const queryBranch = req.query.branch_id;
        const bid = headerBranch ? parseInt(headerBranch, 10) : (queryBranch ? parseInt(queryBranch, 10) : null);
        req.effectiveBranchId = (bid != null && !Number.isNaN(bid)) ? bid : null;
      } else {
        req.effectiveBranchId = req.user.branchId || null;
      }

      next();
    } catch (err) {
      console.error('Auth middleware: Database error:', err);
      return res.status(500).json({ error: err.message });
    }
  })();
}

// Role-based authorization middleware
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

// Branch access check (users can only access their branch's data unless admin)
function requireBranchAccess() {
  return (req, res, next) => {
    if (isDev) {
      console.log('requireBranchAccess: Checking access for user:', req.user?.username, 'role:', req.user?.role);
    }
    if (!req.user) {
      if (isDev) console.log('requireBranchAccess: No user found');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admin can access all branches
    if (req.user.role === 'admin') {
      if (isDev) console.log('requireBranchAccess: Admin user, allowing access');
      return next();
    }

    // Other users must have a branch assigned
    if (!req.user.branchId) {
      if (isDev) console.log('requireBranchAccess: User has no branch assigned');
      return res.status(403).json({ error: 'No branch assigned' });
    }

    if (isDev) console.log('requireBranchAccess: User has branch, allowing access');
    next();
  };
}

// Cleaning services: only admin or branches with cleaning_services feature
function requireCleaningAccess() {
  return requireBranchFeature('cleaning_services');
}

/**
 * Require that the user's branch has the given feature enabled (admin bypasses).
 * Use after authenticate. Use for routes that must respect admin-configured branch privileges.
 */
function requireBranchFeature(featureKey) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.role === 'admin') {
      return next();
    }
    if (!req.user.branchId) {
      return res.status(403).json({ error: 'This feature is not available for your account.' });
    }
    try {
      const row = await db.get(
        'SELECT 1 FROM branch_features WHERE branch_id = $1 AND feature_key = $2 AND is_enabled = true',
        [req.user.branchId, featureKey]
      );
      if (row) {
        return next();
      }
      res.status(403).json({ error: 'This feature is not enabled for your branch. Contact your administrator.' });
    } catch (err) {
      console.error('requireBranchFeature:', err);
      res.status(500).json({ error: err.message });
    }
  };
}

/** Require at least one of the given branch features (admin bypasses). */
function requireBranchFeatureAny(...featureKeys) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.role === 'admin') {
      return next();
    }
    if (!req.user.branchId) {
      return res.status(403).json({ error: 'This feature is not available for your account.' });
    }
    try {
      for (const key of featureKeys) {
        const row = await db.get(
          'SELECT 1 FROM branch_features WHERE branch_id = $1 AND feature_key = $2 AND is_enabled = true',
          [req.user.branchId, key]
        );
        if (row) return next();
      }
      res.status(403).json({ error: 'This feature is not enabled for your branch. Contact your administrator.' });
    } catch (err) {
      console.error('requireBranchFeatureAny:', err);
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = {
  authenticate,
  requireRole,
  requireBranchAccess,
  requireReceiptAccess,
  requireCleaningAccess,
  requireBranchFeature,
  requireBranchFeatureAny,
};

