const Payment = require('../models/paymentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const Student = require('../models/studentModel');
const { syncPayments, verifyTransaction } = require('../services/stellarService');
const { SCHOOL_WALLET, ACCEPTED_ASSETS } = require('../config/stellarConfig');
const crypto = require('crypto');

// GET /api/payments/instructions/:studentId
async function getPaymentInstructions(req, res) {
  try {
    const { studentId } = req.params;
    res.json({
      walletAddress: SCHOOL_WALLET,
      memo: studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
      note: 'Include the payment intent memo exactly when sending payment to ensure your fees are credited.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/intent
async function createPaymentIntent(req, res) {
  try {
    const { studentId } = req.body;
    const student = await Student.findOne({ studentId });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // Generate a unique memo for this payment
    const memo = crypto.randomBytes(4).toString('hex').toUpperCase();

    const intent = await PaymentIntent.create({
      studentId,
      amount: student.feeAmount,
      memo,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
    });

    res.status(201).json(intent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/verify
async function verifyPayment(req, res) {
  try {
    const { txHash } = req.body;
    if (!txHash) return res.status(400).json({ error: 'txHash is required' });

    // Reject duplicates before hitting the Stellar network
    const existing = await Payment.findOne({ txHash });
    if (existing) {
      return res.status(409).json({
        error: `Transaction ${txHash} has already been processed`,
        code: 'DUPLICATE_TX',
      });
    }

    const result = await verifyTransaction(txHash);

    // Persist the verified payment
    await recordPayment({
      studentId: result.memo,
      txHash: result.hash,
      amount: result.amount,
      feeAmount: result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      memo: result.memo,
      confirmedAt: new Date(result.date),
    });

    res.json(result);
  } catch (err) {
    const statusMap = {
      TX_FAILED: 400,
      MISSING_MEMO: 400,
      INVALID_DESTINATION: 400,
      UNSUPPORTED_ASSET: 400,
      DUPLICATE_TX: 409,
    };
    const status = statusMap[err.code] || 500;
    console.error(`[verifyPayment] ${err.code || 'ERROR'}: ${err.message}`);
    res.status(status).json({ error: err.message, code: err.code || 'INTERNAL_ERROR' });
  }
}

// POST /api/payments/sync
async function syncAllPayments(req, res) {
  try {
    await syncPayments();
    res.json({ message: 'Sync complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/:studentId
async function getStudentPayments(req, res) {
  try {
    const payments = await Payment.find({ studentId: req.params.studentId }).sort({ confirmedAt: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/accepted-assets
async function getAcceptedAssets(req, res) {
  try {
    const assets = Object.values(ACCEPTED_ASSETS).map(a => ({
      code: a.code,
      type: a.type,
      displayName: a.displayName,
    }));
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getPaymentInstructions,
  verifyPayment,
  syncAllPayments,
  getStudentPayments,
  getAcceptedAssets,
  createPaymentIntent,
};
