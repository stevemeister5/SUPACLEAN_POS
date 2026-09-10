/**
 * Role-Based Permissions Middleware
 * Defines what each role can and cannot do in the system
 */

// Define what each role can do
const ROLE_PERMISSIONS = {
  admin: {
    // Admin can do everything
    canManageUsers: true,
    canManageBranches: true,
    canEditPrices: true,
    canViewAllBranches: true,
    canManageOrders: true,        // Can edit/update/delete orders
    canCreateOrders: true,         // Can create new orders
    canCollect: true,              // Can collect ready receipts
    canViewReports: true,          // Can view all reports
    canManageCash: true,           // Can manage daily cash and reconciliation
    canReconcile: true,            // Can lock a day and send director closing report
    canManageCustomers: true,      // Can add/edit/delete customers
    canManageExpenses: true,       // Can manage expenses
    canViewDashboard: true,        // Can view dashboard
    canManagePayroll: true,        // Full payroll setup/run/reports
    canRecordSalaryAdvances: true, // Can post salary advances
  },
  manager: {
    canManageUsers: false,
    canManageBranches: false,
    canEditPrices: false,
    canViewAllBranches: false,
    canManageOrders: true,        // Can edit/update order status
    canCreateOrders: true,         // Can create new orders
    canCollect: true,              // Can collect ready receipts
    canViewReports: true,          // Can view reports for their branch
    canManageCash: true,           // Can manage daily cash for their branch
    canReconcile: true,            // Branch managers close the day
    canManageCustomers: true,      // Can add/edit customers
    canManageExpenses: true,       // Can manage expenses for their branch
    canViewDashboard: true,        // Can view dashboard
    canManagePayroll: false,
    canRecordSalaryAdvances: true,
  },
  cashier: {
    canManageUsers: false,
    canManageBranches: false,
    canEditPrices: false,
    canViewAllBranches: false,
    canManageOrders: false,        // Cannot edit/update order status
    canCreateOrders: true,         // Can create new orders
    canCollect: true,              // Can collect ready receipts (front-office handoff)
    canViewReports: false,         // Limited reports (only their own transactions)
    canManageCash: true,           // Can record payments / opening / deposits
    canReconcile: false,           // Day lock + director report is manager+
    canManageCustomers: false,     // Cannot add/edit customers (only view/search)
    canManageExpenses: false,      // Cannot manage expenses
    canViewDashboard: true,        // Can view dashboard
    canManagePayroll: false,
    canRecordSalaryAdvances: true,
  },
  processor: {
    canManageUsers: false,
    canManageBranches: false,
    canEditPrices: false,
    canViewAllBranches: false,
    canManageOrders: true,         // Can update order status (ready, collected)
    canCreateOrders: false,        // Cannot create orders
    canCollect: true,              // Can hand off ready receipts
    canViewReports: false,         // Cannot view reports
    canManageCash: false,          // Cannot manage cash
    canReconcile: false,
    canManageCustomers: false,     // Cannot manage customers
    canManageExpenses: false,      // Cannot manage expenses
    canViewDashboard: true,        // Can view dashboard (to see pending orders)
    canManagePayroll: false,
    canRecordSalaryAdvances: false,
  }
};

/**
 * Middleware to check if user has a specific permission
 * @param {string} permission - The permission to check (e.g., 'canManageOrders')
 * @returns {Function} Express middleware function
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role;
    const permissions = ROLE_PERMISSIONS[userRole];

    if (!permissions) {
      return res.status(403).json({ 
        error: `Invalid user role: ${userRole}` 
      });
    }

    if (!permissions[permission]) {
      return res.status(403).json({ 
        error: `You don't have permission to perform this action. Required permission: ${permission}` 
      });
    }

    next();
  };
}

/** Allow route when the user has at least one of the listed permissions. */
function requireAnyPermission(...permissionList) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const allowed = permissionList.some((p) => hasPermission(req.user, p));
    if (!allowed) {
      return res.status(403).json({
        error: `You don't have permission to perform this action. Required one of: ${permissionList.join(', ')}`,
      });
    }
    next();
  };
}

/**
 * Helper function to check if a user has a specific permission
 * Useful for conditional logic in routes or for frontend checks
 * @param {Object} user - User object with role property
 * @param {string} permission - The permission to check
 * @returns {boolean} True if user has permission
 */
function hasPermission(user, permission) {
  if (!user || !user.role) return false;
  const permissions = ROLE_PERMISSIONS[user.role];
  return permissions && permissions[permission] === true;
}

/**
 * Get all permissions for a role
 * @param {string} role - User role
 * @returns {Object} Permissions object
 */
function getRolePermissions(role) {
  return ROLE_PERMISSIONS[role] || {};
}

module.exports = {
  ROLE_PERMISSIONS,
  requirePermission,
  requireAnyPermission,
  hasPermission,
  getRolePermissions
};
