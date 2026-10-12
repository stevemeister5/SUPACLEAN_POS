const express = require('express');
const router = express.Router();
const db = require('../database/query');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/permissions');

router.use(authenticate);

// Loyalty Configuration
const LOYALTY_CONFIG = {
  pointsPerTSh: 1 / 20000, // 1 point per 20,000 TSh spent
  minSpendForPoint: 20000, // Minimum spend to earn 1 point
  minRedeemPoints: 10, // Minimum points required to redeem
  pointsPerRedemption: 10, // Every 10 points converts to one discount block
  redemptionValueTSh: 10000, // Discount granted per 10-point block (10 points = 10,000 TSh)
  tiers: {
    Bronze: { minPoints: 0, multiplier: 1 },
    Silver: { minPoints: 500, multiplier: 1.2 },
    Gold: { minPoints: 2000, multiplier: 1.5 },
    Platinum: { minPoints: 5000, multiplier: 2 }
  }
};

// Calculate tier based on lifetime points
function calculateTier(lifetimePoints) {
  if (lifetimePoints >= LOYALTY_CONFIG.tiers.Platinum.minPoints) return 'Platinum';
  if (lifetimePoints >= LOYALTY_CONFIG.tiers.Gold.minPoints) return 'Gold';
  if (lifetimePoints >= LOYALTY_CONFIG.tiers.Silver.minPoints) return 'Silver';
  return 'Bronze';
}

// Get customer loyalty info (create if doesn't exist)
router.get('/customer/:customerId', async (req, res) => {
  const { customerId } = req.params;

  try {
    let loyalty = await db.get(
      'SELECT * FROM loyalty_points WHERE customer_id = ?',
      [customerId]
    );

    if (!loyalty) {
      // Initialize loyalty for customer
      const result = await db.run(
        'INSERT INTO loyalty_points (customer_id, current_points, lifetime_points, tier) VALUES (?, ?, ?, ?) RETURNING id',
        [customerId, 0, 0, 'Bronze']
      );
      res.json({
        customer_id: parseInt(customerId),
        current_points: 0,
        lifetime_points: 0,
        tier: 'Bronze',
        next_tier: 'Silver',
        points_to_next_tier: LOYALTY_CONFIG.tiers.Silver.minPoints
      });
    } else {
      // Calculate next tier info
      const nextTiers = ['Silver', 'Gold', 'Platinum'];
      const currentTierIndex = ['Bronze', 'Silver', 'Gold', 'Platinum'].indexOf(loyalty.tier);
      const nextTier = currentTierIndex < 3 ? nextTiers[currentTierIndex] : null;
      const pointsToNext = nextTier
        ? LOYALTY_CONFIG.tiers[nextTier].minPoints - loyalty.lifetime_points
        : 0;

      res.json({
        ...loyalty,
        next_tier: nextTier,
        points_to_next_tier: Math.max(0, pointsToNext)
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get loyalty transaction history
router.get('/customer/:customerId/transactions', async (req, res) => {
  const { customerId } = req.params;
  const { limit = 50 } = req.query;

  try {
    const rows = await db.all(
      `SELECT lt.*, o.receipt_number 
       FROM loyalty_transactions lt
       LEFT JOIN orders o ON lt.order_id = o.id
       WHERE lt.customer_id = ?
       ORDER BY lt.created_at DESC
       LIMIT ?`,
      [customerId, parseInt(limit)]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Award points (prefer server-side awardPointsOnCollection from orders; this route is staff-gated)
router.post('/earn', requireAnyPermission('canManageOrders', 'canManageCash'), async (req, res) => {
  const { customerId, orderId, orderAmount } = req.body;

  if (!customerId || !orderAmount) {
    return res.status(400).json({ error: 'Customer ID and order amount are required' });
  }

  // Calculate points (1 point per 20,000 TSh spent)
  const pointsEarned = Math.floor(orderAmount / LOYALTY_CONFIG.minSpendForPoint);

  try {
    // Get current loyalty info
    let loyalty = await db.get(
      'SELECT * FROM loyalty_points WHERE customer_id = ?',
      [customerId]
    );

    if (!loyalty) {
      // Initialize loyalty
      const newTier = calculateTier(pointsEarned);
      const result = await db.run(
        'INSERT INTO loyalty_points (customer_id, current_points, lifetime_points, tier) VALUES (?, ?, ?, ?) RETURNING id',
        [customerId, pointsEarned, pointsEarned, newTier]
      );
      
      // Record transaction
      await db.run(
        'INSERT INTO loyalty_transactions (customer_id, order_id, transaction_type, points, description, balance_after) VALUES (?, ?, ?, ?, ?, ?)',
        [customerId, orderId, 'earned', pointsEarned, `Points earned for order`, pointsEarned]
      );
      
      res.json({
        points_earned: pointsEarned,
        current_points: pointsEarned,
        lifetime_points: pointsEarned,
        tier: newTier
      });
    } else {
      // Update existing loyalty
      const newLifetimePoints = loyalty.lifetime_points + pointsEarned;
      const newCurrentPoints = loyalty.current_points + pointsEarned;
      const newTier = calculateTier(newLifetimePoints);

      await db.run(
        'UPDATE loyalty_points SET current_points = ?, lifetime_points = ?, tier = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?',
        [newCurrentPoints, newLifetimePoints, newTier, customerId]
      );
      
      // Record transaction
      await db.run(
        'INSERT INTO loyalty_transactions (customer_id, order_id, transaction_type, points, description, balance_after) VALUES (?, ?, ?, ?, ?, ?)',
        [customerId, orderId, 'earned', pointsEarned, `Points earned for order`, newCurrentPoints]
      );
      
      res.json({
        points_earned: pointsEarned,
        current_points: newCurrentPoints,
        lifetime_points: newLifetimePoints,
        tier: newTier,
        tier_upgraded: newTier !== loyalty.tier
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redeem points for discount (10 points = 10,000 TSh discount)
router.post('/redeem', requireAnyPermission('canManageOrders', 'canManageCash'), async (req, res) => {
  const { customerId, points, orderId, rewardId } = req.body;

  if (!customerId || !points || points <= 0) {
    return res.status(400).json({ error: 'Customer ID and valid points amount are required' });
  }

  // Minimum redemption: 10 points (worth 10,000 TSh)
  if (points < LOYALTY_CONFIG.minRedeemPoints) {
    return res.status(400).json({
      error: `Minimum ${LOYALTY_CONFIG.minRedeemPoints} points required to redeem (worth TSh ${LOYALTY_CONFIG.redemptionValueTSh.toLocaleString()} discount)`
    });
  }

  // Only full 10-point blocks convert to discount (prevents silently wasting points)
  if (points % LOYALTY_CONFIG.pointsPerRedemption !== 0) {
    return res.status(400).json({
      error: `Redeem in multiples of ${LOYALTY_CONFIG.pointsPerRedemption} points (${LOYALTY_CONFIG.pointsPerRedemption} points = TSh ${LOYALTY_CONFIG.redemptionValueTSh.toLocaleString()} discount)`
    });
  }

  try {
    const loyalty = await db.get(
      'SELECT * FROM loyalty_points WHERE customer_id = ?',
      [customerId]
    );

    if (!loyalty || loyalty.current_points < points) {
      return res.status(400).json({ error: `Insufficient points. Current balance: ${loyalty?.current_points || 0} points` });
    }

    const newPoints = loyalty.current_points - points;
    // Discount: every 10 points = 10,000 TSh discount
    const discountAmount = Math.floor(points / LOYALTY_CONFIG.pointsPerRedemption) * LOYALTY_CONFIG.redemptionValueTSh;

    await db.run(
      'UPDATE loyalty_points SET current_points = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?',
      [newPoints, customerId]
    );
    
    // Record transaction
    const description = points === LOYALTY_CONFIG.pointsPerRedemption
      ? 'Points redeemed for Free Wash (worth 10,000 TSh)' 
      : `Points redeemed for ${discountAmount.toLocaleString()} TSh discount`;
    
    await db.run(
      'INSERT INTO loyalty_transactions (customer_id, order_id, transaction_type, points, description, balance_after) VALUES (?, ?, ?, ?, ?, ?)',
      [customerId, orderId || null, 'redeemed', -points, description, newPoints]
    );
    
    res.json({
      points_redeemed: points,
      current_points: newPoints,
      discount_amount: discountAmount,
      message: points === LOYALTY_CONFIG.pointsPerRedemption
        ? 'Free wash redeemed successfully (worth 10,000 TSh)' 
        : `Discount of TSh ${discountAmount.toLocaleString()} applied`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get available rewards
router.get('/rewards', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT * FROM loyalty_rewards WHERE is_active = ? ORDER BY points_required ASC',
      [true]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get loyalty tiers info
router.get('/tiers', (req, res) => {
  res.json(LOYALTY_CONFIG.tiers);
});

// Helper function to award points on collection (exported for use in orders.js)
async function awardPointsOnCollection(customerId, orderId, orderAmount) {
  // Calculate points (1 point per 20,000 TSh spent)
  const pointsEarned = Math.floor(orderAmount / LOYALTY_CONFIG.minSpendForPoint);

  try {
    let loyalty = await db.get(
      'SELECT * FROM loyalty_points WHERE customer_id = ?',
      [customerId]
    );

    if (!loyalty) {
      const newTier = calculateTier(pointsEarned);
      const result = await db.run(
        'INSERT INTO loyalty_points (customer_id, current_points, lifetime_points, tier) VALUES (?, ?, ?, ?) RETURNING id',
        [customerId, pointsEarned, pointsEarned, newTier]
      );
      
      await db.run(
        'INSERT INTO loyalty_transactions (customer_id, order_id, transaction_type, points, description, balance_after) VALUES (?, ?, ?, ?, ?, ?)',
        [customerId, orderId, 'earned', pointsEarned, `Points earned for order collection`, pointsEarned]
      );
      
      return { points_earned: pointsEarned, tier: newTier };
    } else {
      const newLifetimePoints = loyalty.lifetime_points + pointsEarned;
      const newCurrentPoints = loyalty.current_points + pointsEarned;
      const newTier = calculateTier(newLifetimePoints);

      await db.run(
        'UPDATE loyalty_points SET current_points = ?, lifetime_points = ?, tier = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?',
        [newCurrentPoints, newLifetimePoints, newTier, customerId]
      );
      
      await db.run(
        'INSERT INTO loyalty_transactions (customer_id, order_id, transaction_type, points, description, balance_after) VALUES (?, ?, ?, ?, ?, ?)',
        [customerId, orderId, 'earned', pointsEarned, `Points earned for order collection`, newCurrentPoints]
      );
      
      return {
        points_earned: pointsEarned,
        current_points: newCurrentPoints,
        lifetime_points: newLifetimePoints,
        tier: newTier,
        tier_upgraded: newTier !== loyalty.tier
      };
    }
  } catch (err) {
    console.error('Error awarding loyalty points:', err);
    throw err;
  }
}

module.exports = router;
module.exports.awardPointsOnCollection = awardPointsOnCollection;
