/**
 * Order Item Photos API
 * Thermal POS / camera uploads for extra item descriptions.
 * Stores under uploads/item-photos/ and records in order_item_photos.
 */

const express = require('express');
const router = express.Router();
const db = require('../database/query');
const { authenticate, requireBranchAccess } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getBranchFilter } = require('../utils/branchFilter');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadsDir = process.env.VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, '../../uploads');
const itemPhotosDir = path.join(uploadsDir, 'item-photos');

try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  if (!fs.existsSync(itemPhotosDir)) fs.mkdirSync(itemPhotosDir, { recursive: true });
} catch (error) {
  console.error('Item photo directory unavailable:', error && error.message ? error.message : error);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, itemPhotosDir),
  filename: (req, file, cb) => {
    const ext = (file.mimetype === 'image/png') ? '.png' : (file.mimetype === 'image/webp') ? '.webp' : '.jpg';
    const name = `order-${req.body.order_id || 'temp'}-${Date.now()}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype);
    cb(null, !!ok);
  }
});

// List photos for an order (or by order_id query)
router.get('/', authenticate, requireBranchAccess(), async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.status(400).json({ error: 'order_id is required' });

  const branchFilter = getBranchFilter(req, 'p');
  try {
    let q = `SELECT p.id, p.order_id, p.branch_id, p.file_path, p.file_name, p.mime_type, p.caption, p.created_at, p.created_by
       FROM order_item_photos p
       JOIN orders o ON o.id = p.order_id
       WHERE p.order_id = ?`;
    const pars = [order_id];
    if (branchFilter.clause) {
      q += ' AND (p.branch_id = ? OR p.branch_id IS NULL)';
      pars.push(branchFilter.params[0]);
    }
    q += ' ORDER BY p.created_at ASC';
    const rows = await db.all(q, pars);
    res.json(rows || []);
  } catch (err) {
    if (err.message && /relation "order_item_photos" does not exist/i.test(err.message)) {
      return res.json([]);
    }
    console.error('Error fetching order item photos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload photo for an order (thermal POS / camera)
router.post(
  '/upload',
  authenticate,
  requireBranchAccess(),
  requirePermission('canManageOrders'),
  upload.single('photo'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No photo file uploaded' });

    const { order_id, caption } = req.body;
    if (!order_id) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: 'order_id is required' });
    }

    const branchId = req.user?.branchId || null;
    const relativePath = path.relative(path.join(__dirname, '../..'), req.file.path).replace(/\\/g, '/');

    try {
      await db.run(
        `INSERT INTO order_item_photos (order_id, branch_id, file_path, file_name, mime_type, caption, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [order_id, branchId, relativePath, req.file.originalname || req.file.filename, req.file.mimetype || 'image/jpeg', caption || null, req.user?.username || 'Cashier']
      );
      const row = await db.get('SELECT * FROM order_item_photos WHERE order_id = ? ORDER BY created_at DESC LIMIT 1', [order_id]);
      res.status(201).json({ message: 'Photo uploaded', photo: row });
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      if (err.message && /relation "order_item_photos" does not exist/i.test(err.message)) {
        return res.status(503).json({ error: 'Order item photos not set up. Run scripts/add-order-item-photos.sql and retry.' });
      }
      console.error('Error saving order item photo:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
