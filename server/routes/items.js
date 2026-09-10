const express = require('express');
const router = express.Router();
const db = require('../database/query');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getBranchFilter } = require('../utils/branchFilter');

// Get all items (admin sees all, others see only active)
router.get('/', authenticate, async (req, res) => {
  try {
    const { category, include_inactive } = req.query;
    let query = `
      SELECT i.*, 
             COALESCE(bp.price, i.base_price) as price,
             bp.id as branch_price_id
      FROM items i
      LEFT JOIN branch_item_prices bp ON i.id = bp.item_id 
        AND bp.branch_id = $1
        AND bp.is_active = TRUE
      WHERE 1=1
    `;
    let params = [req.user.branchId || null];
    
    if (req.user.role !== 'admin' || include_inactive !== 'true') {
      query += ' AND i.is_active = TRUE';
    }
    
    if (category) {
      query += ' AND i.category = $' + (params.length + 1);
      params.push(category);
    }
    
    query += ' ORDER BY i.category, i.name';
    
    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching items:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get item by ID
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  
  try {
    const query = `
      SELECT i.*, 
             COALESCE(bp.price, i.base_price) as price,
             bp.id as branch_price_id
      FROM items i
      LEFT JOIN branch_item_prices bp ON i.id = bp.item_id 
        AND bp.branch_id = $1
        AND bp.is_active = TRUE
      WHERE i.id = $2
    `;
    const row = await db.get(query, [req.user.branchId || null, id]);
    
    if (!row) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(row);
  } catch (err) {
    console.error('Error fetching item:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get items by category
router.get('/category/:category', authenticate, async (req, res) => {
  const { category } = req.params;
  
  try {
    const query = `
      SELECT i.*, 
             COALESCE(bp.price, i.base_price) as price
      FROM items i
      LEFT JOIN branch_item_prices bp ON i.id = bp.item_id 
        AND bp.branch_id = $1
        AND bp.is_active = TRUE
      WHERE i.category = $2 AND i.is_active = TRUE
      ORDER BY i.name
    `;
    const rows = await db.all(query, [req.user.branchId || null, category]);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching items by category:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create new item (admin only)
router.post('/', authenticate, requireRole('admin'), requirePermission('canEditPrices'), async (req, res) => {
  const { name, description, category, base_price, service_type, is_active } = req.body;

  if (!name || !category || base_price === undefined) {
    return res.status(400).json({ error: 'Name, category, and base_price are required' });
  }

  try {
    const result = await db.run(
      'INSERT INTO items (name, description, category, base_price, service_type, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, description || null, category, base_price, service_type || 'Wash, Press & Hanged', is_active !== undefined ? is_active : true]
    );

    // Create the service counterpart (same name, same base price) so New Order
    // lines created from this item link to a matching service and every pricing
    // path (price list, service fallback, service-based reports) stays identical.
    await db.run(
      `INSERT INTO services (name, description, base_price, price_per_item, price_per_kg, is_active)
       VALUES ($1, $2, $3, 0, 0, TRUE)`,
      [name, service_type || 'Wash, Press & Hanged', base_price]
    );

    const item = await db.get('SELECT * FROM items WHERE id = $1', [result.lastID]);
    res.status(201).json(item);
  } catch (err) {
    console.error('Error creating item:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update item (admin only)
router.put('/:id', authenticate, requireRole('admin'), requirePermission('canEditPrices'), async (req, res) => {
  const { id } = req.params;
  const { name, description, category, base_price, service_type, is_active } = req.body;

  try {
    // Capture the pre-update name/price so the legacy service counterpart
    // (matched by name) can be kept in sync below.
    const oldItem = await db.get('SELECT name, base_price FROM items WHERE id = $1', [id]);
    if (!oldItem) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const result = await db.run(
      'UPDATE items SET name = $1, description = $2, category = $3, base_price = $4, service_type = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7',
      [name, description, category, base_price, service_type, is_active !== undefined ? is_active : true, id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Keep the service counterpart identical to the Price List edit so the
    // Services tab and any service-based pricing never drift from the price list.
    const nameOrPriceChanged = oldItem.name !== name || parseFloat(oldItem.base_price) !== parseFloat(base_price);
    if (nameOrPriceChanged) {
      await db.run(
        'UPDATE services SET name = $1, base_price = $2 WHERE LOWER(name) = LOWER($3)',
        [name, base_price, oldItem.name]
      );
    }

    const item = await db.get('SELECT * FROM items WHERE id = $1', [id]);
    res.json(item);
  } catch (err) {
    console.error('Error updating item:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get branch-specific price for item (admin only)
router.get('/:id/branch-price/:branchId', authenticate, requireRole('admin'), async (req, res) => {
  const { id, branchId } = req.params;
  
  try {
    const row = await db.get(
      'SELECT * FROM branch_item_prices WHERE item_id = $1 AND branch_id = $2',
      [id, branchId]
    );
    
    if (!row) {
      // Return base price if no branch-specific price
      const item = await db.get('SELECT base_price FROM items WHERE id = $1', [id]);
      return res.json({ item_id: id, branch_id: parseInt(branchId), price: item?.base_price || 0, is_custom: false });
    }
    
    res.json(row);
  } catch (err) {
    console.error('Error fetching branch price:', err);
    res.status(500).json({ error: err.message });
  }
});

// Set branch-specific price for item (admin only)
router.post('/:id/branch-price/:branchId', authenticate, requireRole('admin'), requirePermission('canEditPrices'), async (req, res) => {
  const { id, branchId } = req.params;
  const { price } = req.body;
  
  if (price === undefined || price === null) {
    return res.status(400).json({ error: 'Price is required' });
  }
  
  try {
    // Verify item and branch exist
    const item = await db.get('SELECT id FROM items WHERE id = $1', [id]);
    const branch = await db.get('SELECT id FROM branches WHERE id = $1', [branchId]);
    
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }
    
    // Upsert branch price
    const result = await db.run(
      `INSERT INTO branch_item_prices (branch_id, item_id, price, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (branch_id, item_id)
       DO UPDATE SET price = $3, updated_at = CURRENT_TIMESTAMP, is_active = TRUE
       RETURNING id`,
      [branchId, id, price]
    );
    
    const branchPrice = await db.get(
      'SELECT * FROM branch_item_prices WHERE id = $1',
      [result.lastID]
    );
    
    res.json(branchPrice);
  } catch (err) {
    console.error('Error setting branch price:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete branch-specific price (revert to base price) - admin only
router.delete('/:id/branch-price/:branchId', authenticate, requireRole('admin'), requirePermission('canEditPrices'), async (req, res) => {
  const { id, branchId } = req.params;
  
  try {
    const result = await db.run(
      'DELETE FROM branch_item_prices WHERE item_id = $1 AND branch_id = $2',
      [id, branchId]
    );
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Branch price not found' });
    }
    
    res.json({ message: 'Branch price deleted successfully. Item will use base price.' });
  } catch (err) {
    console.error('Error deleting branch price:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
