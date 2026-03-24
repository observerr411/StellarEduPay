const crypto = require('crypto');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const { syncPayments, verifyTransaction, recordPayment, finalizeConfirmedPayments } = require('../services/stellarService');
const PaymentIntent = require('../models/paymentIntentModel');
const Student = require('../models/studentModel');
const PendingVerification = require('../models/pendingVerificationModel');
const { syncPayments, verifyTransaction, recordPayment, finalizeConfirmedPayments } = require('../services/stellarService');
const { queueForRetry } = require('../services/retryService');
const { SCHOOL_WALLET, ACCEPTED_ASSETS } = require('../config/stellarConfig');

// Permanent error codes that should NOT be retried
const PERMANENT_FAIL_CODES = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];

function wrapStellarError(err) {
  if (!err.code) {
    err.code = 'STELLAR_NETWORK_ERROR';
    err.message = `Stellar network error: ${err.message}`;
  }
  return err;
}

// GET /api/payments/instructions/:studentId
async function getPaymentInstructions(req, res, next) {
  try {
    res.json({
      walletAddress: SCHOOL_WALLET,
      memo: req.params.studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
      note: 'Include the payment intent memo exactly when sending payment to ensure your fees are credited.',
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/intent
async function createPaymentIntent(req, res) {
  try {
    const { studentId } = req.body;
    const student = await Student.findOne({ studentId });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const memo = crypto.randomBytes(4).toString('hex').toUpperCase();
    const intent = await PaymentIntent.create({
      studentId,
      amount: student.feeAmount,
      memo,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    res.status(201).json(intent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/verify
async function verifyPayment(req, res, next) {
  try {
    const { txHash } = req.body;
    if (!txHash) {
      const err = new Error('txHash is required');
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    // Check for already-processed or already-queued transactions
    const existing = await Payment.findOne({ txHash });
    if (existing) {
      const err = new Error(`Transaction ${txHash} has already been processed`);
      err.code = 'DUPLICATE_TX';
      return next(err);
    }

    let result;
    try {
      result = await verifyTransaction(txHash);
    } catch (err) {
      const failCodes = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];
      if (failCodes.includes(err.code)) {
        // Record a failed payment for audit purposes
        await Payment.create({
          studentId: 'unknown',
          txHash,
          transactionHash: txHash,
          amount: 0,
          status: 'failed',
          createdAt: new Date(),
        }).catch(() => {});
      if (PERMANENT_FAIL_CODES.includes(err.code)) {
        // Permanently invalid — record as failed and surface the error
        await Payment.create({ studentId: 'unknown', txHash, amount: 0, status: 'failed' }).catch(() => {});
        return next(err);
      }

      // Transient Stellar network error — cache for retry so the tx is not lost
      await queueForRetry(txHash, req.body.studentId || null, err.message);
      return res.status(202).json({
        message: 'Stellar network is temporarily unavailable. Your transaction has been queued and will be verified automatically once the network recovers.',
        txHash,
        status: 'queued_for_retry',
      });
    }

    if (!result) {
      return res.status(404).json({ error: 'Transaction not found or invalid' });
    }

    const now = new Date();

    await recordPayment({
      studentId: result.studentId || result.memo,
      txHash: result.hash,
      transactionHash: result.hash,   // audit: canonical on-chain reference
      amount: result.amount,
      feeAmount: result.expectedAmount || result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      status: 'confirmed',
      memo: result.memo,
      confirmedAt: new Date(result.date), // audit: ledger confirmation time
      verifiedAt: now,                    // audit: when this endpoint was called
      confirmedAt: result.date ? new Date(result.date) : new Date(),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/sync
async function syncAllPayments(req, res, next) {
  try {
    await syncPayments();
    res.json({ message: 'Sync complete' });
  } catch (err) {
    const wrapped = wrapStellarError(err);
    // If the sync itself fails due to a network outage, report it clearly
    // (individual tx caching happens inside stellarService during sync)
    next(wrapped);
  }
}

// GET /api/payments/:studentId
async function getStudentPayments(req, res, next) {
  try {
    const payments = await Payment.find({ studentId: req.params.studentId }).sort({ confirmedAt: -1 });
    res.json(payments);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/accepted-assets
async function getAcceptedAssets(req, res, next) {
  try {
    res.json({
      assets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/overpayments
async function getOverpayments(req, res) {
  try {
    const overpayments = await Payment.find({ feeValidationStatus: 'overpaid' }).sort({ confirmedAt: -1 });
    const totalExcess = overpayments.reduce((sum, p) => sum + (p.excessAmount || 0), 0);
    res.json({ count: overpayments.length, totalExcess, overpayments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/balance/:studentId
async function getStudentBalance(req, res) {
  try {
    const { studentId } = req.params;
    const student = await Student.findOne({ studentId });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const result = await Payment.aggregate([
      { $match: { studentId } },
      { $group: { _id: null, totalPaid: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const totalPaid = result.length ? parseFloat(result[0].totalPaid.toFixed(7)) : 0;
    const remainingBalance = parseFloat(Math.max(0, student.feeAmount - totalPaid).toFixed(7));
    const excessAmount = totalPaid > student.feeAmount
      ? parseFloat((totalPaid - student.feeAmount).toFixed(7))
      : 0;

    res.json({
      studentId,
      feeAmount: student.feeAmount,
      totalPaid,
      remainingBalance,
      excessAmount,
      feePaid: totalPaid >= student.feeAmount,
      installmentCount: result.length ? result[0].count : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/suspicious
async function getSuspiciousPayments(req, res) {
  try {
    const suspicious = await Payment.find({ isSuspicious: true }).sort({ confirmedAt: -1 });
    res.json({ count: suspicious.length, suspicious });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/pending
async function getPendingPayments(req, res) {
  try {
    const pending = await Payment.find({ confirmationStatus: 'pending_confirmation' }).sort({ confirmedAt: -1 });
    res.json({ count: pending.length, pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/finalize
async function finalizePayments(req, res) {
  try {
    await finalizeConfirmedPayments();
    res.json({ message: 'Finalization complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/retry-queue — observability endpoint for the retry queue
async function getRetryQueue(req, res) {
  try {
    const [pending, deadLetter, resolved] = await Promise.all([
      PendingVerification.find({ status: 'pending' }).sort({ nextRetryAt: 1 }),
      PendingVerification.find({ status: 'dead_letter' }).sort({ updatedAt: -1 }),
      PendingVerification.find({ status: 'resolved' }).sort({ resolvedAt: -1 }).limit(20),
    ]);
    res.json({
      pending: { count: pending.length, items: pending },
      dead_letter: { count: deadLetter.length, items: deadLetter },
      recently_resolved: { count: resolved.length, items: resolved },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getPaymentInstructions,
  createPaymentIntent,
  verifyPayment,
  syncAllPayments,
  getStudentPayments,
  getAcceptedAssets,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  finalizePayments,
  getRetryQueue,
};
